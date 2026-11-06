import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORAGE_KEY_FOR_TESTS } from '../../src/store';
import { readRenderedName } from './helpers/cdp-shadow';
import { expect, test } from './fixtures/extension';

const PEOPLE_CSV = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'people.csv');

async function setPeople(page: import('@playwright/test').Page, people: Record<string, string>): Promise<void> {
  await page.evaluate(
    ([key, value]) => chrome.storage.local.set({ [key]: value }),
    [STORAGE_KEY_FOR_TESTS, people] as const,
  );
}

test.describe('content script', () => {
  test('draws the real name over a marker whose id is in the list', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Jane Example' });

    const page = await context.newPage();
    await page.goto('/page.html');

    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');
  });

  test('matches ids case-insensitively: a lower-case list id against an upper-case marker id', async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc2: 'John Doe' }); // fixture marker is data-zt-id="MACC2"

    const page = await context.newPage();
    await page.goto('/page.html');

    await expect.poll(() => readRenderedName(page, 'MACC2')).toBe('John Doe');
  });

  test('leaves a marker whose id is not in the list as the page drew it', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, {});

    const page = await context.newPage();
    await page.goto('/page.html');

    await expect(page.locator('#marker-macc1')).toHaveText('Macc1');
    await expect(page.locator('#marker-macc1')).not.toHaveAttribute('data-zt-name');
  });

  test('replaces a marker added to the page after it loaded', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc3: 'Added Later' });

    const page = await context.newPage();
    await page.goto('/page.html');
    await page.locator('#add-marker-button').click();

    await expect.poll(() => readRenderedName(page, 'macc3')).toBe('Added Later');
  });

  test('replaces a marker after a person is added to the list, with no reload', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, {});

    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBeUndefined();

    await setPeople(popup, { macc1: 'Jane Example' });

    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');
  });

  test("the page's own script cannot read the name through innerText, outerHTML or a capture-phase window listener", async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Jane Example' });

    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');

    const innerText = await page.evaluate(() => document.body.innerText);
    const outerHtml = await page.locator('#marker-macc1').evaluate((el) => el.outerHTML);
    const captured = await page.evaluate(() => window.__capturedMessages);

    expect(innerText).not.toContain('Jane Example');
    expect(outerHtml).not.toContain('Jane Example');
    expect(JSON.stringify(captured)).not.toContain('Jane Example');
  });

  test('the extension makes no network request', async ({ context, extensionId, baseURL }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Jane Example' });

    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');

    const fixtureOrigin = new URL(baseURL ?? '').origin;
    const foreign = requests.filter((url) => new URL(url).origin !== fixtureOrigin);
    expect(foreign).toEqual([]);
  });
});

test.describe('popup', () => {
  test.beforeEach(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(() => chrome.storage.local.clear());
    await popup.close();
  });

  test('imports people.csv from the #3785 export format; every row with a name is imported', async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await popup.setInputFiles('#import-file', PEOPLE_CSV);

    await expect(popup.locator('#message')).toContainText('Imported 2 rows, skipped 1');
    await expect(popup.locator('#list')).toContainText('Jane Example (macc1)');
    await expect(popup.locator('#list')).toContainText('John Doe (macc2)');
  });

  test('skips a row with an empty id or an empty name, and reports why', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await popup.setInputFiles('#import-file', PEOPLE_CSV);

    await expect(popup.locator('#message')).toContainText('row 4: empty name');
  });

  test('asks before an import replaces existing rows, and "Cancel" leaves the list unchanged', async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Old Name' });
    // The popup draws its list once when it opens; reopen it to show the seeded row.
    await popup.reload();

    popup.once('dialog', (dialog) => dialog.dismiss());
    await popup.setInputFiles('#import-file', PEOPLE_CSV);

    await expect(popup.locator('#message')).toContainText('Import cancelled');
    await expect(popup.locator('#list')).toContainText('Old Name (macc1)');
    await expect(popup.locator('#list')).not.toContainText('Jane Example');
  });

  test('accepting the replace prompt imports the new rows', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Old Name' });

    popup.once('dialog', (dialog) => dialog.accept());
    await popup.setInputFiles('#import-file', PEOPLE_CSV);

    await expect(popup.locator('#list')).toContainText('Jane Example (macc1)');
  });

  test('adds, edits, deletes and searches a row', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await popup.locator('#add-id').fill('macc9');
    await popup.locator('#add-name').fill('Added Person');
    await popup.locator('#add-button').click();
    await expect(popup.locator('#list')).toContainText('Added Person (macc9)');

    popup.once('dialog', (dialog) => dialog.accept('Edited Person'));
    await popup.locator('#list li', { hasText: 'Added Person' }).locator('button', { hasText: 'Edit' }).click();
    await expect(popup.locator('#list')).toContainText('Edited Person (macc9)');
    await expect(popup.locator('#list')).not.toContainText('Added Person');

    await popup.locator('#add-id').fill('macc10');
    await popup.locator('#add-name').fill('Second Person');
    await popup.locator('#add-button').click();

    await popup.locator('#search').fill('macc9');
    await expect(popup.locator('#list')).toContainText('Edited Person');
    await expect(popup.locator('#list')).not.toContainText('Second Person');
    await popup.locator('#search').fill('');

    popup.once('dialog', (dialog) => dialog.accept());
    await popup.locator('#list li', { hasText: 'Edited Person' }).locator('button', { hasText: 'Delete' }).click();
    await expect(popup.locator('#list')).not.toContainText('Edited Person');
    await expect(popup.locator('#list')).toContainText('Second Person');
  });

  test('exports the list as a CSV file', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await setPeople(popup, { macc1: 'Jane Example' });
    await popup.reload();

    const [download] = await Promise.all([popup.waitForEvent('download'), popup.locator('#export-button').click()]);
    const path = await download.path();
    const fs = await import('node:fs');
    const text = fs.readFileSync(path!, 'utf8');

    expect(text).toBe('username,name\r\nmacc1,Jane Example\r\n');
  });

  test('shows the extension version and a link to the source repository', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator('#version')).toHaveText(/^v\d+\.\d+\.\d+/);
    await expect(popup.locator('#source-link')).toHaveAttribute('href', 'https://github.com/Truertech/zero-trust-translator');
  });
});
