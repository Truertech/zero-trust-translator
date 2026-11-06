// Loads the unpacked dev build into a persistent Chromium context, the
// pattern Playwright documents for testing a browser extension
// (https://playwright.dev/docs/chrome-extensions). The dev build's fixed
// test-only `manifest.key` (`tests/fixtures/dev-extension-key.json`) gives
// a fixed, known extension id. Each test gets its own profile folder, so a
// test can close Chrome and open the same profile again (#3797).
import { type BrowserContext, type Worker, test as base, chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is three folders below the repository root.
const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const EXTENSION_PATH = join(ROOT, 'dist-dev');

export const DEV_EXTENSION_ID: string = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'dev-extension-key.json'), 'utf8'),
).extensionId;

/** Opens Chrome with the dev build on the given profile folder. */
export function launch(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    // The "chromium" channel is the full browser in its new headless mode.
    // Playwright's default headless shell does not load extensions.
    channel: 'chromium',
    viewport: { width: 380, height: 600 },
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
}

/** The extension's service worker, started if Chrome has not started it yet. */
export async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  const running = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${DEV_EXTENSION_ID}/`));
  return running ?? (await context.waitForEvent('serviceworker', (w) => w.url().startsWith(`chrome-extension://${DEV_EXTENSION_ID}/`)));
}

export const test = base.extend<{ userDataDir: string; context: BrowserContext; extensionId: string; serviceWorker: Worker }>({
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'zt-profile-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  context: async ({ userDataDir }, use) => {
    const context = await launch(userDataDir);
    await use(context);
    await context.close();
  },
  // eslint-disable-next-line no-empty-pattern
  extensionId: async ({}, use) => {
    await use(DEV_EXTENSION_ID);
  },
  serviceWorker: async ({ context }, use) => {
    await use(await serviceWorkerOf(context));
  },
});

export const expect = test.expect;