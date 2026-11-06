// Loads the unpacked dev build into a persistent Chromium context, the
// pattern Playwright documents for testing a browser extension
// (https://playwright.dev/docs/chrome-extensions). This repository has no
// background service worker (the content script and the popup are all it
// ships), so the usual "read the id off the service worker" trick does not
// apply; the dev build's fixed test-only `manifest.key`
// (`tests/fixtures/dev-extension-key.json`) gives a fixed, known extension
// id instead.
import { type BrowserContext, test as base, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION_PATH = join(ROOT, 'dist-dev');

export const DEV_EXTENSION_ID: string = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'dev-extension-key.json'), 'utf8'),
).extensionId;

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--headless=new'],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({}, use) => {
    await use(DEV_EXTENSION_ID);
  },
});

export const expect = test.expect;
