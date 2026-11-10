/**
 * `zt:listCodes` and `zt:encryptForSend` (#3919): the codes table (board 1)
 * and the Allow window (board 6/11). `tests/e2e/translator.spec.ts` drives
 * the real Allow window; this file is the service worker logic underneath
 * it, with a fake `chrome.windows` standing in for the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackground, type Background, type MessageSender } from '../../src/background';
import type { AllowRequestView, CodeView, EncryptForSendResult, ListCodesResult, Request, SendBatch } from '../../src/messages';
import { CONTENT_SENDER, EXTENSION_ID, EXTENSION_ORIGIN, FakeChrome, PAGE_SENDER } from './fake-chrome';

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const SLOW = 30_000;

const ALLOW_SENDER: MessageSender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}allow.html?requestId=x` };
const PAGE_ORIGIN = 'https://app.example.org';

/**
 * A real RSA keypair stands in for the walled Lambda's pinned key
 * (#3920 publishes the real one; `walled-keys.ts` pins none until then).
 * The private half lets the `zt:encryptForSend` tests decrypt what they
 * get back, the same as the walled Lambda would.
 */
const walledKeyPair = await crypto.subtle.generateKey(
  { name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ['encrypt', 'decrypt'],
);
const walledPublicKeySpki = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', walledKeyPair.publicKey))));

vi.mock('../../src/walled-keys', () => ({
  walledKeyFor: (origin: string) => (origin === PAGE_ORIGIN ? { keyId: 'test-dev', publicKeySpki: walledPublicKeySpki } : undefined),
}));

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Decrypts a `SendBatch` the same way the walled Lambda would, with its private key. */
async function decryptBatch(batch: SendBatch): Promise<{ token: string; timestamp: string; rows: { code: string; phone: string; firstName: string }[] }> {
  const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, walledKeyPair.privateKey, b64ToBytes(batch.wrappedKey));
  const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(batch.iv) }, aesKey, b64ToBytes(batch.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** `username, kind, email, first name, last name, phone, address, postcode`: 2 UK mobiles, 1 with none. */
const PEOPLE_CSV = [
  'username,kind,email,first name,last name,phone,address,postcode',
  'Macc1,member,jane@example.org,Jane,Example,07700 900123,1 High Street,AB1 2CD',
  'Macc2,member,bob@example.org,Bob,Stone,07700 900456,2 Low Road,ZZ1 1ZZ',
  'Macc3,member,sam@example.org,Sam,Taylor,,,',
].join('\n');

interface World {
  chrome: FakeChrome;
  bg: Background;
  clock: { t: number };
  send<T = unknown>(request: unknown, sender?: MessageSender): Promise<T>;
}

function world(): World {
  const chrome = new FakeChrome();
  const clock = { t: T0 };
  const bg = createBackground(chrome.api, () => clock.t);
  return { chrome, bg, clock, send: (request, sender = PAGE_SENDER) => bg.handle(request as Request, sender) as Promise<any> };
}

function expectOk(response: unknown): any {
  expect(response).toMatchObject({ ok: true });
  return response;
}

/** A vault with a password and the 3 people of `PEOPLE_CSV`, unlocked. */
async function setUp(w: World): Promise<void> {
  expectOk(await w.send({ type: 'setupAddPassword', password: 'violet harbour lantern 47' }));
  const { code } = expectOk(await w.send({ type: 'setupMakeRecovery' }));
  expectOk(await w.send({ type: 'setupFinish', saved: true }));
  expectOk(await w.send({ type: 'applyImport', text: PEOPLE_CSV, fields: [] }));
  void code;
}

async function lock(w: World): Promise<void> {
  expectOk(await w.send({ type: 'lock' }));
}

function codesOf(result: ListCodesResult): CodeView[] {
  if (!('codes' in result)) {
    throw new Error(`expected codes, got ${JSON.stringify(result)}`);
  }
  return result.codes;
}

function byUsername(codes: CodeView[], username: string): CodeView {
  const found = codes.find((c) => c.username === username);
  if (!found) {
    throw new Error(`no code for ${username}`);
  }
  return found;
}

describe('zt:listCodes', () => {
  let w: World;

  beforeEach(async () => {
    w = world();
    await setUp(w);
  }, SLOW);

  it('lists codes without PII', async () => {
    const result = await w.send<ListCodesResult>({ type: 'zt:listCodes' });
    const codes = codesOf(result);
    expect(codes).toHaveLength(3);
    expect(byUsername(codes, 'Macc1')).toMatchObject({ hasValidMobile: true });
    expect(byUsername(codes, 'Macc2')).toMatchObject({ hasValidMobile: true });
    expect(byUsername(codes, 'Macc3')).toMatchObject({ hasValidMobile: false });
    for (const code of codes) {
      expect(code.code).toMatch(/^ref-[a-z0-9]{8}$/);
    }
    const text = JSON.stringify(result);
    for (const pii of ['Jane', 'Example', 'jane@example.org', '07700', 'High Street', 'AB1 2CD']) {
      expect(text).not.toContain(pii);
    }
  });

  it('gives the same code on a later call, from a legacy record or a fresh one', async () => {
    const first = codesOf(await w.send<ListCodesResult>({ type: 'zt:listCodes' }));
    const second = codesOf(await w.send<ListCodesResult>({ type: 'zt:listCodes' }));
    expect(second.map((c) => c.code).sort()).toEqual(first.map((c) => c.code).sort());
  });

  it('survives a restart: the same codes come back from a fresh worker over the same storage', async () => {
    const before = codesOf(await w.send<ListCodesResult>({ type: 'zt:listCodes' }));
    const restarted = createBackground(FakeChrome.from(w.chrome.snapshot()).api, () => w.clock.t);
    const after = codesOf((await restarted.handle({ type: 'zt:listCodes' }, PAGE_SENDER)) as ListCodesResult);
    expect(after.map((c) => c.code).sort()).toEqual(before.map((c) => c.code).sort());
  });

  it('refuses while the list is locked, and opens the extension page so the admin can unlock', async () => {
    await lock(w);
    const result = await w.send<ListCodesResult>({ type: 'zt:listCodes' });
    expect(result).toEqual({ refused: 'locked' });
    expect(w.chrome.created).toContainEqual(expect.stringContaining('popup.html'));
  });

  it('answers a content script the same as the popup: `zt:listCodes` bypasses the extension-page check', async () => {
    const result = await w.send<ListCodesResult>({ type: 'zt:listCodes' }, CONTENT_SENDER);
    expect(codesOf(result)).toHaveLength(3);
  });
});

describe('zt:encryptForSend', () => {
  let w: World;

  beforeEach(async () => {
    w = world();
    await setUp(w);
  }, SLOW);

  async function codesFor(usernames: string[]): Promise<string[]> {
    const codes = codesOf(await w.send<ListCodesResult>({ type: 'zt:listCodes' }));
    return usernames.map((u) => byUsername(codes, u).code);
  }

  it('refuses an origin with no pinned key, and opens no Allow window', async () => {
    const [macc1] = await codesFor(['Macc1']);
    const result = await w.send<EncryptForSendResult>({
      type: 'zt:encryptForSend',
      operation: 'sms',
      codes: [macc1!],
      template: 'Hi [[FirstName]]',
      peopleCount: 1,
      origin: 'https://unknown.example.org',
    });
    expect(result).toEqual({ refused: 'unknown-origin' });
    expect(w.chrome.windowsCreated).toHaveLength(0);
  });

  it('refuses while the list is locked, and opens no Allow window', async () => {
    await lock(w);
    const result = await w.send<EncryptForSendResult>({
      type: 'zt:encryptForSend',
      operation: 'sms',
      codes: ['ref-anything1'],
      template: 'Hi [[FirstName]]',
      peopleCount: 1,
      origin: PAGE_ORIGIN,
    });
    expect(result).toEqual({ refused: 'locked' });
    expect(w.chrome.windowsCreated).toHaveLength(0);
  });

  it('shows the Allow window the count of codes the list holds, not the count the page claims', async () => {
    const [macc1, macc2] = await codesFor(['Macc1', 'Macc2']);
    const pending = w.send<EncryptForSendResult>({
      type: 'zt:encryptForSend',
      operation: 'sms',
      codes: [macc1!, macc2!, 'ref-not-a-real-code'],
      template: 'Hi [[FirstName]], see you Saturday.',
      peopleCount: 999,
      origin: PAGE_ORIGIN,
    });
    await vi.waitFor(() => expect(w.chrome.windowsCreated).toHaveLength(1));
    const requestId = new URL(w.chrome.windowsCreated[0]!.url).searchParams.get('requestId')!;
    const { request } = expectOk(await w.send({ type: 'zt:getAllowRequest', requestId }, ALLOW_SENDER)) as { request: AllowRequestView };
    expect(request).toMatchObject({ operation: 'sms', template: 'Hi [[FirstName]], see you Saturday.', peopleCount: 2, origin: PAGE_ORIGIN });

    expectOk(await w.send({ type: 'zt:resolveAllow', requestId, decision: 'deny' }, ALLOW_SENDER));
    expect(await pending).toEqual({ refused: 'denied' });
  });

  it('on Allow, encrypts a batch of the matched rows and nothing in clear, and closes the window', async () => {
    const [macc1, macc2] = await codesFor(['Macc1', 'Macc2']);
    const pending = w.send<EncryptForSendResult>({
      type: 'zt:encryptForSend',
      operation: 'eventInvite',
      codes: [macc1!, macc2!],
      template: 'Can you come? [[RsvpLink]]',
      peopleCount: 2,
      origin: PAGE_ORIGIN,
    });
    await vi.waitFor(() => expect(w.chrome.windowsCreated).toHaveLength(1));
    const windowId = 1;
    const requestId = new URL(w.chrome.windowsCreated[0]!.url).searchParams.get('requestId')!;

    expectOk(await w.send({ type: 'zt:resolveAllow', requestId, decision: 'allow' }, ALLOW_SENDER));
    const result = await pending;
    if (!('batch' in result)) {
      throw new Error(`expected a batch, got ${JSON.stringify(result)}`);
    }
    const batch: SendBatch = result.batch;
    expect(Object.keys(batch).sort()).toEqual(['ciphertext', 'iv', 'wrappedKey']);
    expect(JSON.stringify(batch)).not.toMatch(/Jane|Example|Bob|Stone|07700/);
    expect(w.chrome.windowsRemoved).toContain(windowId);

    const plaintext = await decryptBatch(batch);
    expect(plaintext.rows.sort((a, b) => a.code.localeCompare(b.code))).toEqual(
      [
        { code: macc1!, phone: '+447700900123', firstName: 'Jane' },
        { code: macc2!, phone: '+447700900456', firstName: 'Bob' },
      ].sort((a, b) => a.code.localeCompare(b.code)),
    );
    expect(plaintext.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('closing the window with no decision refuses the same as Deny', async () => {
    const [macc1] = await codesFor(['Macc1']);
    const pending = w.send<EncryptForSendResult>({
      type: 'zt:encryptForSend',
      operation: 'sms',
      codes: [macc1!],
      template: 'Hi [[FirstName]]',
      peopleCount: 1,
      origin: PAGE_ORIGIN,
    });
    await vi.waitFor(() => expect(w.chrome.windowsCreated).toHaveLength(1));
    // `windows.create`'s `.then` (which records the window id against the
    // pending request) runs a tick after `windowsCreated` is pushed to, so
    // a macrotask flush is needed before the id is there to match on.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // `createBackground` alone wires no `chrome.windows.onRemoved` listener
    // (only `installBackground` does, for the real worker); call the
    // background's own handler directly, as `background.test.ts` does for
    // `onIdleState`/`onCeremonyPort`.
    w.bg.onWindowRemoved(1);
    expect(await pending).toEqual({ refused: 'denied' });
  });

  it('refuses `zt:getAllowRequest` and `zt:resolveAllow` from outside the extension', async () => {
    await expect(w.send({ type: 'zt:getAllowRequest', requestId: 'x' }, CONTENT_SENDER)).resolves.toMatchObject({ ok: false, error: 'forbidden' });
    await expect(w.send({ type: 'zt:resolveAllow', requestId: 'x', decision: 'allow' }, CONTENT_SENDER)).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
  });
});
