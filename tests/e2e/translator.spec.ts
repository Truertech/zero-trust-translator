import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { readBadge, readRenderedName } from './helpers/cdp-shadow';
import { expect, launch, test } from './fixtures/extension';
import { WALLED_DEV_KEY_PATH } from './global-setup';
import type { EncryptForSendResult, ListCodesResult, Request, SendBatch } from '../../src/messages';

const PEOPLE_CSV = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'people.csv');
const PASSWORD = 'violet harbour lantern 47';
const LOCKED_TEXT = 'Zero Trust Translator is locked · open the extension to unlock';

async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

/** Board 13 → 14 → 15: sets up the list with a password. Returns the recovery code. */
async function setUpWithPassword(popup: Page): Promise<string> {
  await popup.getByTestId('zt-setup-password').click();
  await popup.getByTestId('zt-password-new').fill(PASSWORD);
  await popup.getByTestId('zt-password-again').fill(PASSWORD);
  await popup.getByTestId('zt-setup-continue').click();
  const code = (await popup.getByTestId('zt-recovery-code').innerText()).replace(/\s+/g, '');
  await expect(popup.getByTestId('zt-finish')).toBeDisabled();
  await popup.getByTestId('zt-recovery-saved').check();
  await popup.getByTestId('zt-finish').click();
  await expect(popup.getByTestId('zt-recovery-code')).toHaveCount(0);
  return code;
}

async function importPeople(popup: Page): Promise<void> {
  await popup.getByTestId('zt-import').click();
  await popup.getByTestId('zt-import-file').setInputFiles(PEOPLE_CSV);
  await expect(popup.getByTestId('zt-import-result')).toBeVisible();
  await popup.getByTestId('zt-import-done').click();
  await expect(popup.getByTestId('zt-main')).toBeVisible();
}

async function setUpWithPeople(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await openPopup(context, extensionId);
  await setUpWithPassword(popup);
  await importPeople(popup);
  return popup;
}

async function storageLocal(worker: Worker): Promise<string> {
  return worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
}

test.describe('first start', () => {
  test('the popup offers no import and no list before setup ends', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId);

    await expect(popup.getByTestId('zt-setup')).toBeVisible();
    await expect(popup.getByTestId('zt-import')).toHaveCount(0);
    await expect(popup.getByTestId('zt-list')).toHaveCount(0);
  });

  test('a v0.1.0 list is encrypted at setup and the plain key is removed', async ({ context, extensionId, serviceWorker }) => {
    await serviceWorker.evaluate(() => chrome.storage.local.set({ 'zt-people-v1': { macc1: 'Jane Example' } }));
    const popup = await openPopup(context, extensionId);
    await setUpWithPassword(popup);
    await expect(popup.getByTestId('zt-main')).toBeVisible();
    await expect(popup.getByTestId('zt-count')).toContainText('1');

    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');
    const local = await storageLocal(serviceWorker);
    expect(local).not.toContain('Jane');
    expect(local).not.toContain('zt-people-v1');
  });
});

test.describe('content script', () => {
  test('draws the real name over a marker in the list, case-insensitively, and shows the badge', async ({ context, extensionId }) => {
    await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');

    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');
    await expect.poll(() => readRenderedName(page, 'MACC2')).toBe('John Doe');
    await expect.poll(() => readBadge(page)).toEqual({ state: 'unlocked', text: 'Names shown by Zero Trust Translator · 2 of 2 on this page' });
  });

  test('replaces a marker added to the page after it loaded', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    await popup.getByTestId('zt-add').click();
    await popup.getByTestId('zt-add-username').fill('macc3');
    await popup.getByTestId('zt-add-email').fill('macc3@example.org');
    await popup.getByTestId('zt-add-save').click();

    const page = await context.newPage();
    await page.goto('/page.html');
    await page.getByTestId('add-marker-button').click();

    // A person with no name is not drawn: the marker keeps the page's text.
    await expect.poll(() => readBadge(page)).toEqual({ state: 'unlocked', text: 'Names shown by Zero Trust Translator · 2 of 3 on this page' });
    expect(await readRenderedName(page, 'macc3')).toBeUndefined();
    await expect(page.getByTestId('marker-macc3')).toHaveText('Macc3');
  });

  test("the page's own script cannot read the name through innerText, outerHTML or a capture-phase window listener", async ({ context, extensionId }) => {
    await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');

    const innerText = await page.evaluate(() => document.documentElement.innerText);
    const outerHtml = await page.evaluate(() => document.documentElement.outerHTML);
    const captured = await page.evaluate(() => window.__capturedMessages);
    const shadow = await page.getByTestId('marker-macc1').evaluate((el) => el.shadowRoot);

    expect(innerText).not.toContain('Jane Example');
    expect(outerHtml).not.toContain('Jane Example');
    expect(JSON.stringify(captured)).not.toContain('Jane Example');
    expect(shadow).toBeNull();
  });
});

test.describe('lock and unlock', () => {
  test('Lock hides the names on an open tab with no reload, and the password brings them back', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');

    await popup.getByTestId('zt-lock').click();
    await expect(popup.getByTestId('zt-locked')).toBeVisible();
    await expect.poll(() => readRenderedName(page, 'macc1')).toBeUndefined();
    await expect(page.getByTestId('marker-macc1')).toHaveText('Macc1');
    await expect.poll(() => readBadge(page)).toEqual({ state: 'locked', text: LOCKED_TEXT });

    await popup.getByTestId('zt-unlock-password').click();
    await popup.getByTestId('zt-password-field').fill(PASSWORD);
    await popup.getByTestId('zt-password-submit').click();
    await expect(popup.getByTestId('zt-main')).toBeVisible();
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');
  });

  test('a wrong password says so and the page keeps the username', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    await popup.getByTestId('zt-lock').click();
    const page = await context.newPage();
    await page.goto('/page.html');

    await popup.getByTestId('zt-unlock-password').click();
    await popup.getByTestId('zt-password-field').fill('not the password at all');
    await popup.getByTestId('zt-password-submit').click();

    await expect(popup.getByTestId('zt-password-error')).toHaveText('That password is not right');
    await expect.poll(() => readBadge(page)).toEqual({ state: 'locked', text: LOCKED_TEXT });
    expect(await readRenderedName(page, 'macc1')).toBeUndefined();
  });

  test('the list is locked after Chrome closes and opens the same profile', async ({ context, extensionId, userDataDir }) => {
    await setUpWithPeople(context, extensionId);
    await context.close();

    const reopened = await launch(userDataDir);
    try {
      const page = await reopened.newPage();
      await page.goto('/page.html');
      await expect.poll(() => readBadge(page)).toEqual({ state: 'locked', text: LOCKED_TEXT });
      const popup = await openPopup(reopened, extensionId);
      await expect(popup.getByTestId('zt-locked')).toBeVisible();
    } finally {
      await reopened.close();
    }
  });

  test('the recovery code unlocks the list', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId);
    const code = await setUpWithPassword(popup);
    await importPeople(popup);
    await popup.getByTestId('zt-lock').click();

    await popup.getByTestId('zt-unlock-recovery').click();
    await popup.getByTestId('zt-recovery-field').fill(code.toLowerCase());
    await popup.getByTestId('zt-password-submit').click();

    await expect(popup.getByTestId('zt-main')).toBeVisible();
  });
});

test.describe('storage and network', () => {
  test('chrome.storage.local holds no name after an import', async ({ context, extensionId, serviceWorker }) => {
    await setUpWithPeople(context, extensionId);

    const local = await storageLocal(serviceWorker);
    expect(local).not.toContain('Jane');
    expect(local).not.toContain('John');
    expect(local).not.toContain('zt-people-v1');
  });

  test('an export straight after unlock saves an encrypted file with no name in it', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    await popup.getByTestId('zt-export').click();
    await expect(popup.getByTestId('zt-reauth')).toHaveCount(0);

    const [download] = await Promise.all([popup.waitForEvent('download'), popup.getByTestId('zt-export-save').click()]);
    expect(download.suggestedFilename()).toMatch(/^zero-trust-translator-\d{4}-\d{2}-\d{2}\.ztbackup$/);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).not.toContain('Jane');
  });

  test('the extension makes no network request', async ({ context, extensionId, baseURL }) => {
    const requests: string[] = [];
    context.on('request', (request) => requests.push(request.url()));
    await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    await expect.poll(() => readRenderedName(page, 'macc1')).toBe('Jane Example');

    const allowed = [new URL(baseURL ?? '').origin, `chrome-extension://${extensionId}`];
    expect(requests.filter((url) => !allowed.some((origin) => url.startsWith(origin)))).toEqual([]);
  });

  test('the Security page shows the version, and the only method cannot be removed', async ({ context, extensionId }) => {
    await setUpWithPeople(context, extensionId);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(options.getByTestId('zt-version')).toHaveText(/^Zero Trust Translator · v\d+\.\d+\.\d+$/);
    await expect(options.getByTestId('zt-remove-method')).toBeDisabled();
  });
});

// ---- send batch for the walled Lambda (#3919) --------------------------------------

interface WalledDevKey {
  origin: string;
  keyId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}

let walledPrivateKey: CryptoKey;

test.beforeAll(async () => {
  const walledDevKey = JSON.parse(readFileSync(WALLED_DEV_KEY_PATH, 'utf8')) as WalledDevKey;
  walledPrivateKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(walledDevKey.privateKeyPkcs8, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
});

/**
 * Posts one `zt:listCodes`/`zt:encryptForSend` request the way a real app
 * page does: `window.postMessage`, relayed by `content.ts`. A page cannot
 * call `chrome.runtime.sendMessage` itself, only an extension's own script
 * can, which is the whole point of the relay.
 */
function postToTranslator<T>(page: Page, request: Request): Promise<T> {
  return page.evaluate((req) => {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      function onMessage(event: MessageEvent): void {
        const data = event.data as { source?: string; requestId?: string; response?: unknown } | null;
        if (event.source !== window || event.origin !== location.origin || data?.source !== 'zero-trust-translator-extension' || data.requestId !== requestId) {
          return;
        }
        window.removeEventListener('message', onMessage);
        resolve(data.response);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'zero-trust-translator-page', requestId, request: req }, location.origin);
    });
  }, request) as Promise<T>;
}

/** The code `zt:listCodes` minted for each of the given usernames. */
async function codesFor(page: Page, usernames: string[]): Promise<Record<string, string>> {
  const result = await postToTranslator<ListCodesResult>(page, { type: 'zt:listCodes' });
  if (!('codes' in result)) {
    throw new Error(`zt:listCodes refused: ${result.refused}`);
  }
  const byUsername = new Map(result.codes.map((c) => [c.username, c.code]));
  const codes: Record<string, string> = {};
  for (const username of usernames) {
    const code = byUsername.get(username);
    if (!code) {
      throw new Error(`no code for ${username}`);
    }
    codes[username] = code;
  }
  return codes;
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

/** Opens the batch with the dev walled private key, the same way the walled Lambda (#3920) would. */
async function decryptBatch(batch: SendBatch): Promise<{ token: string; timestamp: string; rows: { code: string; phone: string; firstName: string }[] }> {
  const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, walledPrivateKey, b64ToBytes(batch.wrappedKey));
  const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(batch.iv) }, aesKey, b64ToBytes(batch.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

test.describe('send batch (#3919)', () => {
  test("Allow shows the page's operation wording and the matched count, and encrypts a decryptable batch", async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    const codes = await codesFor(page, ['Macc1', 'Macc2']);

    // The page claims an origin that is not its own: `content.ts` always
    // writes `location.origin` over whatever the page sent, so this must
    // not change the outcome.
    const pending = postToTranslator<EncryptForSendResult>(page, {
      type: 'zt:encryptForSend',
      operation: 'Send SMS messages',
      codes: [codes['Macc1']!, codes['Macc2']!],
      peopleCount: 2,
      origin: 'https://not-this-page.example',
    });

    const allowPage = await context.waitForEvent('page');
    await expect(allowPage.getByTestId('zt-allow-operation')).toHaveText('Send SMS messages');
    await expect(allowPage.getByTestId('zt-allow-count')).toHaveText('2');
    await allowPage.getByTestId('zt-allow-allow').click();

    const result = await pending;
    if (!('batch' in result)) {
      throw new Error(`refused: ${result.refused}`);
    }
    const plaintext = await decryptBatch(result.batch);
    const byCode = (a: { code: string }, b: { code: string }): number => a.code.localeCompare(b.code);
    expect(plaintext.rows.sort(byCode)).toEqual(
      [
        { code: codes['Macc1']!, phone: '+447700900123', firstName: 'Jane' },
        { code: codes['Macc2']!, phone: '+447700900456', firstName: 'John' },
      ].sort(byCode),
    );
    expect(plaintext.token).toMatch(/^[0-9a-f]{64}$/);
    await popup.close();
  });

  test('Allow shows the event invite wording, and Deny refuses with no batch', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    const codes = await codesFor(page, ['Macc1']);

    const pending = postToTranslator<EncryptForSendResult>(page, {
      type: 'zt:encryptForSend',
      operation: 'Send SMS event invites',
      codes: [codes['Macc1']!],
      peopleCount: 1,
      origin: 'http://localhost:4321',
    });
    const allowPage = await context.waitForEvent('page');
    await expect(allowPage.getByTestId('zt-allow-operation')).toHaveText('Send SMS event invites');
    await allowPage.getByTestId('zt-allow-deny').click();

    expect(await pending).toEqual({ refused: 'denied' });
    await popup.close();
  });

  test('a locked list refuses zt:encryptForSend before any Allow window opens', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    await popup.getByTestId('zt-lock').click();
    await expect(popup.getByTestId('zt-locked')).toBeVisible();
    const page = await context.newPage();
    await page.goto('/page.html');

    const [result, openedPage] = await Promise.all([
      postToTranslator<EncryptForSendResult>(page, {
        type: 'zt:encryptForSend',
        operation: 'Send SMS messages',
        codes: ['ref-anything'],
        peopleCount: 1,
        origin: 'http://localhost:4321',
      }),
      context.waitForEvent('page'),
    ]);

    expect(result).toEqual({ refused: 'locked' });
    // The locked refusal opens the extension's own unlock tab, not the
    // Allow window (board 6/11): that tab is `popup.html`, not `allow.html`.
    expect(openedPage.url()).toContain('popup.html');
  });

  test('an origin with no pinned key refuses with no Allow window', async ({ context, extensionId, baseURL }) => {
    await setUpWithPeople(context, extensionId);
    const secondOrigin = new URL(baseURL ?? '').origin.replace(/:(\d+)$/, (_match, digits: string) => `:${Number(digits) + 1}`);
    const otherPage = await context.newPage();
    await otherPage.goto(`${secondOrigin}/page.html`);

    const pagesBefore = context.pages().length;
    const result = await postToTranslator<EncryptForSendResult>(otherPage, {
      type: 'zt:encryptForSend',
      operation: 'Send SMS messages',
      codes: ['ref-anything'],
      peopleCount: 1,
      origin: secondOrigin,
    });

    expect(result).toEqual({ refused: 'unknown-origin' });
    expect(context.pages().length).toBe(pagesBefore);
  });

  test('a code the list does not hold is left out of the batch, and the window shows the matched count', async ({ context, extensionId }) => {
    const popup = await setUpWithPeople(context, extensionId);
    const page = await context.newPage();
    await page.goto('/page.html');
    const codes = await codesFor(page, ['Macc1']);

    const pending = postToTranslator<EncryptForSendResult>(page, {
      type: 'zt:encryptForSend',
      operation: 'Send SMS messages',
      codes: [codes['Macc1']!, 'ref-not-in-list'],
      peopleCount: 2,
      origin: 'http://localhost:4321',
    });
    const allowPage = await context.waitForEvent('page');
    await expect(allowPage.getByTestId('zt-allow-count')).toHaveText('1');
    await allowPage.getByTestId('zt-allow-allow').click();

    const result = await pending;
    if (!('batch' in result)) {
      throw new Error(`refused: ${result.refused}`);
    }
    const plaintext = await decryptBatch(result.batch);
    expect(plaintext.rows).toEqual([{ code: codes['Macc1']!, phone: '+447700900123', firstName: 'Jane' }]);
    await popup.close();
  });
});
