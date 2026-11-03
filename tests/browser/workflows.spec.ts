import { test, expect, type Page, type Route } from '@playwright/test';
import { observeCapture, record, assertReleased, decodedSeconds } from './capture.js';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, request }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await request.delete('/api/messages');
  await observeCapture(page);
});

test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('messages record native audio, preview, send complete bytes and reload accepted history', async ({ page, request, browser }, info) => {
  await page.goto('/react/');
  await page.getByRole('button', { name: 'New voice message' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeFocused();
  await record(page, true);
  expect(await decodedSeconds(page, 'Message draft')).toBeGreaterThan(0.1);
  await assertReleased(page);
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.captureTest.urls.size)).toBe(0);
  const data: { messages: { bytes: number }[]; requests: number } = await (await request.get('/api/messages')).json();
  expect(data.requests).toBe(1); expect(data.messages[0].bytes).toBeGreaterThan(0);
  await page.screenshot({ path: '.artifacts/messages-desktop.png', fullPage: true });
  await page.reload();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(1);
  expect(await decodedSeconds(page, 'Accepted voice message')).toBeGreaterThan(0.1);
  await info.attach('native-audio', { body: JSON.stringify({ version: process.env.RECSTEAD_TEST_VERSION,
    browser: browser.version(), bytes: data.messages[0].bytes, nativeDecode: true }), contentType: 'application/json' });
});

test('sent message playback seeks forward and backward through the local HTTP endpoint', async ({ page }) => {
  await page.goto('/react/');
  await page.getByRole('button', { name: 'New voice message' }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(2300); // Retain several native chunks and a meaningful seek target.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Message draft')).toBeVisible();
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  const audio = page.getByLabel('Accepted voice message');
  await expect(audio).toBeVisible();
  await audio.evaluate(async element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Expected message audio');
    await element.play();
  });
  const currentTime = (): Promise<number> => audio.evaluate(element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Expected message audio');
    return element.currentTime;
  });
  await expect.poll(currentTime).toBeGreaterThan(0.05);
  for (const target of [1.5, 0.4]) {
    await audio.evaluate((element, time) => {
      if (!(element instanceof HTMLAudioElement)) throw new Error('Expected message audio');
      element.pause(); element.currentTime = time;
    }, target);
    await expect.poll(() => audio.evaluate(element => {
      if (!(element instanceof HTMLAudioElement)) throw new Error('Expected message audio');
      return element.seeking ? -1 : element.currentTime;
    })).toBeCloseTo(target, 1);
  }
  await audio.evaluate(async element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Expected message audio');
    await element.play();
  });
  await expect.poll(currentTime).toBeGreaterThan(0.5);
  await assertReleased(page);
});

test('a lost response retries the same bytes and identifier without another microphone request', async ({ page, request }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await record(page);
  await page.getByText('Test scenarios', { exact: true }).click();
  await page.getByLabel('Next send').selectOption('drop-response');
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect(page.getByText('Acceptance unknown', { exact: true })).toBeVisible();
  const first: { messages: { id: string; bytes: number }[] } = await (await request.get('/api/messages')).json();
  await page.getByRole('button', { name: 'Retry send' }).click();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(1);
  const second: { messages: { id: string; bytes: number }[]; requests: number } = await (await request.get('/api/messages')).json();
  expect(second.messages).toEqual(first.messages); expect(second.requests).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.captureTest.requests)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.captureTest.urls.size)).toBe(0);
});

test('rejected uploads retry and stopping a slow request reports uncertain acceptance', async ({ page }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await record(page);
  await page.getByText('Test scenarios', { exact: true }).click();
  await page.getByLabel('Next send').selectOption('reject');
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry send' }).click();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(1);
  await record(page);
  await page.getByLabel('Next send').selectOption('delay');
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await expect(page.getByText('Acceptance unknown', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry send' }).click();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(2);
});

test('clear timeout preserves local audio, restores controls and allows retry after server acceptance', async ({ page }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await record(page);
  await page.getByText('Test scenarios', { exact: true }).click();
  await page.getByLabel('Next send').selectOption('reject');
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await page.clock.install();
  let held: Route | undefined;
  let attempts = 0;
  await page.route('**/api/messages', async route => {
    if (route.request().method() === 'DELETE' && ++attempts === 1) {
      // The server commits the clear, but the browser receives no confirmation.
      await route.fetch(); held = route;
    } else await route.continue();
  });
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Clear conversations' }).click();
  await expect.poll(() => held !== undefined).toBe(true);
  await page.clock.fastForward(10_001);
  await expect(page.getByRole('alert')).toContainText('Could not confirm clearing');
  await expect(page.getByRole('alert')).toContainText('may already have cleared');
  await expect(page.getByRole('button', { name: 'New voice message' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'F Friends Local conversation' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Clear conversations' })).toBeEnabled();
  expect(await decodedSeconds(page, 'Unsent voice message')).toBeGreaterThan(0.1);
  // Delivering the old response after its timeout must not erase the retained draft.
  if (!held) throw new Error('Expected the interrupted clear request');
  await held.fulfill({ status: 200, json: { cleared: true } });
  await expect(page.getByLabel('Unsent voice message')).toBeVisible();
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Clear conversations' }).click();
  await expect(page.getByLabel('Unsent voice message')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New voice message' })).toBeEnabled();
  expect(attempts).toBe(2);
  await expect.poll(() => page.evaluate(() => window.captureTest.urls.size)).toBe(0);
});

test('reloading after an unconfirmed clear reports current failures and clears a recovered error', async ({ page }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await record(page);
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect(page.getByLabel('Accepted voice message')).toBeVisible();
  let failReload = true;
  await page.route('**/api/messages', async route => {
    if (route.request().method() === 'DELETE') {
      await route.fetch(); // The server clears its collection but confirmation is lost.
      await route.abort('failed');
    } else if (failReload) {
      await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    } else await route.continue();
  });
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Clear conversations' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not confirm clearing');
  await page.getByRole('button', { name: 'Reload conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('The local message server is unavailable');
  await expect(page.getByRole('alert')).not.toContainText('Could not confirm clearing');
  await expect(page.getByLabel('Accepted voice message')).toBeVisible();
  failReload = false;
  await page.getByRole('button', { name: 'Reload conversation' }).click();
  await expect(page.getByLabel('Accepted voice message')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear conversations' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New voice message' })).toBeEnabled();
});

for (const action of ['close', 'switch', 'discard'] as const) {
  test(`permission pending: ${action} prevents late capture from creating a message`, async ({ page, request }) => {
    await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
    await page.evaluate(() => { window.captureTest.mode = 'defer'; });
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByText('Waiting for microphone permission', { exact: true })).toBeVisible();
    if (action === 'close') await page.getByRole('button', { name: 'Close composer' }).click();
    else if (action === 'switch') await page.getByRole('button', { name: 'F Friends Local conversation' }).click();
    else await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.evaluate(async () => { await window.captureTest.grant(); });
    await assertReleased(page);
    await expect(page.getByLabel('Message draft')).toHaveCount(0);
    expect((await (await request.get('/api/messages')).json()).requests).toBe(0);
  });
}

test('denied microphone can be retried and closing an active composer releases capture', async ({ page }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await page.evaluate(() => { window.captureTest.mode = 'deny'; });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('denied');
  await page.evaluate(() => { window.captureTest.mode = 'normal'; });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close composer' }).click(); await assertReleased(page);
  await expect(page.getByRole('button', { name: 'New voice message' })).toBeFocused();
  await page.getByRole('button', { name: 'New voice message' }).click();
  await record(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await assertReleased(page);
  expect(await page.evaluate(() => window.captureTest.urls.size)).toBe(0);
});

test('partial native output cannot be sent as a completed message', async ({ page }) => {
  await page.goto('/react/'); await page.getByRole('button', { name: 'New voice message' }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.captureTest.fail());
  await expect(page.getByText('This recording is incomplete and cannot be sent. Discard it and try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send voice message', exact: true })).toBeDisabled();
  await assertReleased(page);
});

test('notes survive reload, navigate during recording, and delete all owned playback URLs', async ({ page }) => {
  await page.goto('/vanilla/'); await record(page, true);
  expect(await decodedSeconds(page, 'Note draft')).toBeGreaterThan(0.1);
  await page.getByLabel('Note title').fill('First thought');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'First thought' })).toBeVisible();
  await expect(page.getByLabel('Note draft')).toBeHidden();
  await page.reload();
  await page.getByRole('button', { name: /First thought/ }).click();
  expect(await decodedSeconds(page, 'Saved note playback')).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All notes', exact: true }).click();
  await page.getByRole('button', { name: /First thought/ }).click();
  expect(await page.evaluate(() => window.captureTest.streams[0].getAudioTracks()[0].readyState)).toBe('live');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Note draft')).toBeVisible();
  await page.getByLabel('Note title').fill('Second thought');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second thought' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(2);
  await page.screenshot({ path: '.artifacts/notes-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(1);
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Clear all saved notes' }).click();
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.captureTest.urls.size)).toBe(0);
  await assertReleased(page);
});

test('long note titles keep the heading and New note inside desktop and narrow layouts', async ({ page }) => {
  await page.goto('/vanilla/'); await record(page);
  const title = 'W'.repeat(80);
  await page.getByLabel('Note title').fill(title);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.locator('.workspace-header').evaluate(header => {
      const heading = header.querySelector('h1');
      const button = header.querySelector('button');
      const workspace = header.parentElement;
      if (!heading || !button || !workspace) throw new Error('Expected a heading and New note control in the workspace');
      const bounds = header.getBoundingClientRect();
      const fits = (element: HTMLElement): boolean => {
        const box = element.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && element.scrollWidth <= element.clientWidth + 1;
      };
      return fits(heading) && fits(button) && workspace.scrollWidth <= workspace.clientWidth + 1;
    })).toBe(true);
    await page.screenshot({ path: `.artifacts/notes-long-title-${viewport.width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await assertReleased(page);
});

test('failed save retains a downloadable draft; retry persists exactly one note', async ({ page }) => {
  await page.goto('/vanilla/'); await record(page);
  await page.getByLabel('Note title').fill('Keep this draft');
  await page.getByText('Test scenarios', { exact: true }).click();
  await page.getByLabel('Fail the next save').check();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Simulated storage failure' })).toBeVisible();
  await expect(page.getByLabel('Note draft')).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download draft' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.webm$/);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep this draft' })).toBeVisible();
  expect(await page.evaluate(() => window.captureTest.requests)).toBe(1);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(1);
});

test('notes reject partial output, discard late grants and release capture and URLs on pagehide', async ({ page }) => {
  await page.goto('/vanilla/');
  await page.evaluate(() => { window.captureTest.mode = 'defer'; });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.evaluate(async () => { await window.captureTest.grant(); window.captureTest.mode = 'normal'; });
  await assertReleased(page);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.waitForTimeout(400); await page.evaluate(() => window.captureTest.fail());
  await expect(page.getByText(/This recording is incomplete and cannot be saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await assertReleased(page);
  expect(await page.evaluate(() => window.captureTest.urls.size)).toBe(0);
});

test('notes recover from denied permission and unfinished drafts are not silently saved', async ({ page }) => {
  await page.goto('/vanilla/');
  await page.evaluate(() => { window.captureTest.mode = 'deny'; });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'denied' })).toBeVisible();
  await page.evaluate(() => { window.captureTest.mode = 'normal'; });
  await record(page);
  await expect(page.getByLabel('Note title')).toBeFocused();
  await page.getByLabel('Note title').fill('Unsaved note');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByLabel('Note draft')).toBeHidden();
});

test('saving a retained draft reconnects after browser storage forcibly closes IndexedDB', async ({ page }) => {
  await page.goto('/vanilla/'); await record(page);
  await page.getByLabel('Note title').fill('Keep this after reconnecting');
  await page.getByText('Test scenarios', { exact: true }).click();
  await page.getByLabel('Fail the next save').check();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Simulated storage failure' })).toBeVisible();
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'indexeddb' });
  await devtools.detach();
  await expect(page.getByLabel('Note draft')).toBeVisible();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep this after reconnecting' })).toBeVisible();
  expect(await page.evaluate(() => window.captureTest.requests)).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: /Keep this after reconnecting/ }).click();
  expect(await decodedSeconds(page, 'Saved note playback')).toBeGreaterThan(0.1);
  await expect(page.getByRole('navigation', { name: 'Saved notes' }).getByRole('button')).toHaveCount(1);
});

test('unavailable IndexedDB leaves recording and draft download usable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined }); });
  await page.goto('/vanilla/');
  await expect(page.getByRole('alert').filter({ hasText: 'Local storage is unavailable' })).toBeVisible();
  await record(page);
  await page.getByLabel('Note title').fill('Download instead');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Local storage is unavailable' })).toBeVisible();
  await expect(page.getByLabel('Note draft')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download draft' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.webm$/);
  await assertReleased(page);
});

test('responsive layouts fit a narrow viewport and the synthetic encoder still passes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/react/', '/vanilla/']) {
    await page.goto(route);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.artifacts/${route.includes('react') ? 'messages' : 'notes'}-mobile.png`, fullPage: true });
  }
  await page.goto('/synthetic/');
  await page.getByRole('button', { name: 'Run encoder check' }).click();
  await expect(page.locator('pre')).toContainText('"passed": true', { timeout: 15000 });
  const result: { passed: boolean } = JSON.parse(await page.locator('pre').innerText());
  expect(result.passed).toBe(true);
});
