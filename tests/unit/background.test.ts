/**
 * The service worker (#3797): setup, lock and unlock, the password lockout,
 * the 5-minute check, the list, import and backup, the settings, the
 * content script lookup and the ceremony port. Every request goes through
 * `handle`, the same entry point Chrome's `runtime.onMessage` calls.
 *
 * PBKDF2 runs 600,000 rounds, so one vault is set up once (`buildFixture`)
 * and each test starts a new fake `chrome` from a copy of its storage.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECK_WINDOW_MS,
  DEFAULT_SETTINGS,
  LOCK_REASON_KEY,
  PC_LOCKED_AT_KEY,
  LOCKOUT_KEY,
  PASSWORD_LOCKOUT_MS,
  SETUP_KEY,
  UNLOCKED_KEY,
  VAULT_KEY,
  createBackground,
  installBackground,
  type Background,
  type MessageSender,
} from '../../src/background';
import { CEREMONY_PORT, REFRESH_MESSAGE, type PasskeyMessage, type Request } from '../../src/messages';
import { DUPLICATE_USERNAME_MESSAGE, LEGACY_STORAGE_KEY, MISSING_EMAIL_MESSAGE, MISSING_USERNAME_MESSAGE } from '../../src/store';
import { makeRecoveryCode, randomBytes, toBase64, toBase64Url } from '../../src/vault';
import {
  CONTENT_SENDER,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  FakeChrome,
  PAGE_SENDER,
  TAB_WITHOUT_CONTENT_SCRIPT,
  makePort,
  type StorageSnapshot,
} from './fake-chrome';

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const SLOW = 30_000;
const PASSWORD = 'violet harbour lantern 47';
const OTHER_PASSWORD = 'quiet orange bicycle 1984';

const WRONG_PASSWORD_MESSAGE = 'That password is not right';
const WRONG_RECOVERY_MESSAGE = 'That recovery code is not right';
const WRONG_PASSKEY_MESSAGE = 'That key does not open this list';
const MISSING_ID_COLUMN_MESSAGE = 'The file has no "username" or "reference" column.';
const BAD_FILE_MESSAGE = 'This file is not a Zero Trust Translator backup.';

const PEOPLE_CSV = [
  'username,kind,email,first name,last name,phone,address,postcode',
  'Macc1,member,jane@example.org,,,,,',
  'Mbob,user,bob@example.org,Bob,Stone,07700 900123,2 Low Road,ZZ1 1ZZ',
  'Mnew,member,newbie@example.org,,,,,',
].join('\n');

const NB_MEMBER_CSV = [
  'name,address,postcode,area,email,phone,joinDate',
  'Jane A. Example,1 High Street,AB1 2CD,North, JANE@example.org ,01234 567890,2024-01-01',
].join('\n');

/** Every PII value the fixture list holds, to scan storage for. */
const PLAIN_VALUES = ['Jane', 'Example', 'jane@example.org', 'Bob', 'Stone', 'bob@example.org', '07700', 'Low Road', 'ZZ1 1ZZ', 'newbie@example.org'];

interface World {
  chrome: FakeChrome;
  bg: Background;
  clock: { t: number };
  send(request: unknown, sender?: MessageSender): Promise<any>;
}

function world(snapshot?: StorageSnapshot): World {
  const chrome = snapshot ? FakeChrome.from(snapshot) : new FakeChrome();
  const clock = { t: T0 };
  const bg = createBackground(chrome.api, () => clock.t);
  return { chrome, bg, clock, send: (request, sender = PAGE_SENDER) => bg.handle(request as Request, sender) as Promise<any> };
}

function expectOk(response: any): any {
  expect(response).toMatchObject({ ok: true });
  return response;
}

function expectError(response: any, error: string, message?: string): void {
  expect(response).toEqual({ ok: false, error, message: message ?? expect.any(String) });
}

function passkeyMessage(overrides: Partial<Record<keyof PasskeyMessage, unknown>> = {}): PasskeyMessage {
  return {
    kind: 'cross-platform',
    name: 'YubiKey',
    credentialId: toBase64Url(randomBytes(16)),
    prfSalt: toBase64(randomBytes(32)),
    prfOutput: toBase64(randomBytes(32)),
    transports: ['usb'],
    ...overrides,
  } as PasskeyMessage;
}

function refreshTabs(chrome: FakeChrome): number[] {
  return chrome.sent.filter((s) => (s.message as { type?: string }).type === REFRESH_MESSAGE).map((s) => s.tabId);
}

async function stateOf(w: World): Promise<any> {
  return expectOk(await w.send({ type: 'getState' })).state;
}

async function peopleOf(w: World): Promise<any[]> {
  return expectOk(await w.send({ type: 'getPeople' })).people;
}

interface Fixture {
  /** Storage right after setup and the people.csv import: unlocked, last check at T0. */
  unlocked: StorageSnapshot;
  /** The same storage with the session cleared, as after Chrome restarts. */
  locked: StorageSnapshot;
  recoveryCode: string;
  passkey: PasskeyMessage;
  ids: { password: string; passkey: string; recovery: string };
}

/** Sets up a vault with a password, a security key and a recovery code, from a v0.1.0 list, then imports people.csv. */
async function buildFixture(): Promise<Fixture> {
  const w = world();
  w.chrome.local.data[LEGACY_STORAGE_KEY] = { macc1: 'Jane Example' };
  expectOk(await w.send({ type: 'setupAddPassword', password: PASSWORD }));
  const passkey = passkeyMessage();
  expectOk(await w.send({ type: 'setupAddPasskey', passkey }));
  const { code } = expectOk(await w.send({ type: 'setupMakeRecovery' }));
  expectOk(await w.send({ type: 'setupFinish', saved: true }));
  expectOk(await w.send({ type: 'applyImport', text: PEOPLE_CSV, fields: [] }));
  const methods: { id: string; type: string }[] = (await stateOf(w)).methods;
  const idOf = (type: string): string => methods.find((m) => m.type === type)!.id;
  const unlocked = w.chrome.snapshot();
  return {
    unlocked,
    locked: { local: unlocked.local, session: {} },
    recoveryCode: code,
    passkey,
    ids: { password: idOf('password'), passkey: idOf('passkey'), recovery: idOf('recovery') },
  };
}

let fx: Fixture;

beforeAll(async () => {
  fx = await buildFixture();
}, SLOW);

const unlockedWorld = (): World => world(fx.unlocked);
const lockedWorld = (): World => world(fx.locked);

const recoverySecret = (): object => ({ type: 'recovery', code: fx.recoveryCode });
const passkeySecret = (): object => ({ type: 'passkey', credentialId: fx.passkey.credentialId, prfOutput: fx.passkey.prfOutput });

/** One valid request of each type that needs a vault, built when the fixture exists. */
const VAULT_REQUESTS: [string, () => object][] = [
  ['unlock', () => ({ type: 'unlock', secret: recoverySecret() })],
  ['check', () => ({ type: 'check', secret: recoverySecret() })],
  ['getPeople', () => ({ type: 'getPeople' })],
  ['addPerson', () => ({ type: 'addPerson', username: 'Mzed', email: 'zed@example.org' })],
  ['renameUser', () => ({ type: 'renameUser', from: 'Mbob', to: 'Mrobert' })],
  ['deletePerson', () => ({ type: 'deletePerson', username: 'Mbob' })],
  ['deleteAll', () => ({ type: 'deleteAll' })],
  ['previewImport', () => ({ type: 'previewImport', text: PEOPLE_CSV })],
  ['applyImport', () => ({ type: 'applyImport', text: PEOPLE_CSV, fields: [] })],
  ['importBackup', () => ({ type: 'importBackup', text: '{}', secret: recoverySecret() })],
  ['exportBackup', () => ({ type: 'exportBackup' })],
  ['addPasskey', () => ({ type: 'addPasskey', passkey: passkeyMessage() })],
  ['setPassword', () => ({ type: 'setPassword', password: OTHER_PASSWORD })],
  ['removeMethod', () => ({ type: 'removeMethod', id: 'any' })],
  ['newRecoveryCode', () => ({ type: 'newRecoveryCode' })],
];

describe('setup', () => {
  it('a new install reports the setup phase with no methods and the default settings', async () => {
    const w = world();
    expect(await stateOf(w)).toEqual({
      phase: 'setup',
      version: '1.0.0',
      methods: [],
      settings: DEFAULT_SETTINGS,
      lockReason: null,
      passwordLockedUntil: null,
      lastCheckAt: null,
      now: T0,
      peopleCount: null,
      setupRecoveryMade: false,
    });
  });

  it.each([
    ['too short', 'Short pw 1!'],
    ['one character repeated', 'aaaaaaaaaaaaaaaa'],
    ['in the common list', '123456789012'],
    ['not a string', 123456789012345],
    ['missing', undefined],
  ])('a password that is %s is refused and adds no method', async (_label, password) => {
    const w = world();
    expectError(await w.send({ type: 'setupAddPassword', password }), 'invalid', 'Use at least 12 characters, and not a common password.');
    expect((await stateOf(w)).methods).toEqual([]);
  });

  it(
    'a second password replaces the first, and the pending setup survives a worker restart',
    async () => {
      const w = world();
      expectOk(await w.send({ type: 'setupAddPassword', password: PASSWORD }));
      const first = (await stateOf(w)).methods;
      const restarted = createBackground(w.chrome.api, () => T0);
      expectOk(await restarted.handle({ type: 'setupAddPassword', password: OTHER_PASSWORD }, PAGE_SENDER));
      const second = (await stateOf(w)).methods;
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].type).toBe('password');
      expect(second[0].id).not.toBe(first[0].id);
      expect(Object.keys(second[0]).sort()).toEqual(['createdAt', 'id', 'type']);
    },
    SLOW,
  );

  it('each passkey is added beside the others, and the view holds no wrapped key', async () => {
    const w = world();
    expectOk(await w.send({ type: 'setupAddPasskey', passkey: passkeyMessage({ transports: ['usb', 5, 'nfc'] }) }));
    expectOk(await w.send({ type: 'setupAddPasskey', passkey: passkeyMessage({ kind: 'platform', name: 'Laptop', transports: 'usb' }) }));
    const methods = (await stateOf(w)).methods;
    expect(methods.map((m: any) => [m.kind, m.name, m.transports, m.lastUsedAt])).toEqual([
      ['cross-platform', 'YubiKey', ['usb', 'nfc'], null],
      ['platform', 'Laptop', [], null],
    ]);
    const text = JSON.stringify(methods);
    expect(text).not.toContain('wrapped');
    expect(text).not.toContain('hkdfSalt');
  });

  it.each([
    ['a platform key with no name', { kind: 'platform', name: undefined }, 'Windows Hello'],
    ['a security key with a blank name', { kind: 'cross-platform', name: '   ' }, 'Security key'],
    ['a name with spaces round it', { name: '  Blue key  ' }, 'Blue key'],
    ['a name over 60 characters', { name: 'k'.repeat(80) }, 'k'.repeat(60)],
  ])('%s is saved with the name "%s"', async (_label, overrides, expected) => {
    const w = world();
    expectOk(await w.send({ type: 'setupAddPasskey', passkey: passkeyMessage(overrides) }));
    expect((await stateOf(w)).methods[0].name).toBe(expected);
  });

  it.each([
    ['no passkey', undefined],
    ['an unknown kind', passkeyMessage({ kind: 'hybrid' })],
    ['a credential id that is not text', passkeyMessage({ credentialId: 5 })],
    ['an empty credential id', passkeyMessage({ credentialId: '' })],
    ['a PRF salt that is not text', passkeyMessage({ prfSalt: 5 })],
    ['a PRF output that is not text', passkeyMessage({ prfOutput: 5 })],
    ['a PRF output shorter than 32 bytes', passkeyMessage({ prfOutput: toBase64(randomBytes(31)) })],
  ])('a passkey with %s is refused', async (_label, passkey) => {
    const w = world();
    expectError(await w.send({ type: 'setupAddPasskey', passkey }), 'invalid', 'That is not valid.');
    expect((await stateOf(w)).methods).toEqual([]);
  });

  it('the recovery code needs an unlocking method first, and a second code replaces the first', async () => {
    const w = world();
    expectError(await w.send({ type: 'setupMakeRecovery' }), 'invalid', 'Choose how you unlock the list first.');
    expectOk(await w.send({ type: 'setupAddPasskey', passkey: passkeyMessage() }));
    const { code } = expectOk(await w.send({ type: 'setupMakeRecovery' }));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    const { code: second } = expectOk(await w.send({ type: 'setupMakeRecovery' }));
    expect(second).not.toBe(code);
    const state = await stateOf(w);
    expect(state.setupRecoveryMade).toBe(true);
    expect(state.methods.map((m: any) => m.type)).toEqual(['passkey', 'recovery']);
  });

  it.each([
    ['no method', [], true],
    ['no recovery code', ['passkey'], true],
    ['the saved box not ticked', ['passkey', 'recovery'], false],
    ['saved sent as text', ['passkey', 'recovery'], 'yes'],
  ])('setup does not finish with %s', async (_label, steps, saved) => {
    const w = world();
    for (const step of steps) {
      expectOk(await w.send(step === 'passkey' ? { type: 'setupAddPasskey', passkey: passkeyMessage() } : { type: 'setupMakeRecovery' }));
    }
    expectError(await w.send({ type: 'setupFinish', saved }), 'invalid', 'Choose how you unlock the list, and save the recovery code.');
    expect((await stateOf(w)).phase).toBe('setup');
    expect(w.chrome.local.data[VAULT_KEY]).toBeUndefined();
  });

  it('finishing setup moves the v0.1.0 list into the vault, removes the plain key, unlocks and tells every tab', async () => {
    const w = world();
    w.chrome.local.data[LEGACY_STORAGE_KEY] = { macc1: 'Jane Example', broken: 5 };
    expectOk(await w.send({ type: 'setupAddPasskey', passkey: passkeyMessage() }));
    expectOk(await w.send({ type: 'setupMakeRecovery' }));
    expectOk(await w.send({ type: 'setupFinish', saved: true }));
    expect(w.chrome.local.data).not.toHaveProperty(LEGACY_STORAGE_KEY);
    expect(w.chrome.session.data).not.toHaveProperty(SETUP_KEY);
    const state = await stateOf(w);
    expect(state).toMatchObject({ phase: 'unlocked', lastCheckAt: T0, peopleCount: 1, setupRecoveryMade: true, lockReason: null });
    expect(await peopleOf(w)).toEqual([{ username: 'macc1', name: 'Jane Example', email: '', phone: '', address: '', postcode: '', kind: '' }]);
    expect(w.chrome.idleIntervals).toEqual([DEFAULT_SETTINGS.autoLockMinutes * 60]);
    expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
    expect(JSON.stringify(w.chrome.local.data)).not.toContain('Jane');
  });

  it.each(VAULT_REQUESTS)('%s before setup ends is refused with setup-needed', async (_type, request) => {
    const w = world();
    expectError(await w.send(request()), 'setup-needed', 'Finish setting up the list first.');
  });

  it('lock before setup ends is refused and keeps the setup in progress', async () => {
    const w = world();
    expectOk(await w.send({ type: 'setupAddPassword', password: PASSWORD }));
    const before = structuredClone(w.chrome.session.data);
    expectError(await w.send({ type: 'lock' }), 'setup-needed', 'Finish setting up the list first.');
    expect(w.chrome.session.data).toEqual(before);
  }, SLOW);

  it('a content script gets no names before setup ends', async () => {
    const w = world();
    expect(await w.send({ type: 'lookupNames', ids: ['macc1'] }, CONTENT_SENDER)).toEqual({ ok: true, phase: 'setup', names: {} });
  });

  it.each([
    ['setupAddPassword', () => ({ type: 'setupAddPassword', password: OTHER_PASSWORD })],
    ['setupAddPasskey', () => ({ type: 'setupAddPasskey', passkey: passkeyMessage() })],
    ['setupMakeRecovery', () => ({ type: 'setupMakeRecovery' })],
    ['setupFinish', () => ({ type: 'setupFinish', saved: true })],
  ])('%s after setup is refused with not-in-setup', async (_type, request) => {
    const w = unlockedWorld();
    expectError(await w.send(request()), 'not-in-setup', 'The list is already set up.');
  });
});

describe('storage', () => {
  it('chrome.storage.local holds no name, email, phone, address, postcode or data key in plain text', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'addPerson', username: 'Mzed', email: 'zed.private@example.org' }));
    const local = JSON.stringify(w.chrome.local.data);
    for (const value of [...PLAIN_VALUES, 'zed.private@example.org']) {
      expect(local).not.toContain(value);
    }
    expect(w.chrome.local.data).not.toHaveProperty(LEGACY_STORAGE_KEY);
    const { dataKey } = w.chrome.session.data[UNLOCKED_KEY] as { dataKey: string };
    expect(local).not.toContain(dataKey);
  });

  it('start limits the session area to trusted contexts and sets the idle interval from the settings', async () => {
    const w = unlockedWorld();
    await w.bg.start();
    expectOk(await w.send({ type: 'setSettings', autoLockMinutes: 60 }));
    const restarted = createBackground(w.chrome.api, () => T0);
    await restarted.start();
    expect(w.chrome.session.accessLevels).toEqual(['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
    expect(w.chrome.idleIntervals).toEqual([900, 3600, 3600]);
  });

  it('two requests sent at once are run one after the other, so neither write is lost', async () => {
    const w = unlockedWorld();
    const [a, b] = await Promise.all([
      w.send({ type: 'addPerson', username: 'Mone', email: 'one@example.org' }),
      w.send({ type: 'addPerson', username: 'Mtwo', email: 'two@example.org' }),
    ]);
    expectOk(a);
    expectOk(b);
    expect((await peopleOf(w)).map((p) => p.username)).toEqual(expect.arrayContaining(['Mone', 'Mtwo']));
  });
});

describe('unlock', () => {
  it(
    'the right password unlocks, tells every tab, and changes no method',
    async () => {
      const w = lockedWorld();
      w.clock.t = T0 + 1000;
      const before = JSON.stringify((w.chrome.local.data[VAULT_KEY] as any).methods);
      expectOk(await w.send({ type: 'unlock', secret: { type: 'password', password: PASSWORD } }));
      const state = await stateOf(w);
      expect(state).toMatchObject({ phase: 'unlocked', lastCheckAt: T0 + 1000, peopleCount: 3, lockReason: null });
      expect(JSON.stringify((w.chrome.local.data[VAULT_KEY] as any).methods)).toBe(before);
      expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
      expect(w.chrome.local.data[LOCKOUT_KEY]).toEqual({ failures: 0, lockedUntil: null });
    },
    SLOW,
  );

  it.each([
    ['a wrong password', () => ({ type: 'password', password: OTHER_PASSWORD }), WRONG_PASSWORD_MESSAGE],
    ['a wrong recovery code', () => ({ type: 'recovery', code: makeRecoveryCode() }), WRONG_RECOVERY_MESSAGE],
    ['a recovery code that is not 32 characters', () => ({ type: 'recovery', code: 'ABCD-1234' }), WRONG_RECOVERY_MESSAGE],
    ['the right key with another PRF output', () => ({ type: 'passkey', credentialId: fx.passkey.credentialId, prfOutput: toBase64(randomBytes(32)) }), WRONG_PASSKEY_MESSAGE],
    ['a key the list does not know', () => ({ type: 'passkey', credentialId: 'unknown', prfOutput: fx.passkey.prfOutput }), WRONG_PASSKEY_MESSAGE],
  ])(
    '%s is refused with its own message and the list stays locked',
    async (_label, secret, message) => {
      const w = lockedWorld();
      expectError(await w.send({ type: 'unlock', secret: secret() }), 'wrong-secret', message);
      expect((await stateOf(w)).phase).toBe('locked');
      expect(w.chrome.sent).toEqual([]);
    },
    SLOW,
  );

  it('the recovery code unlocks and sets its usedAt', async () => {
    const w = lockedWorld();
    w.clock.t = T0 + 5000;
    expectOk(await w.send({ type: 'unlock', secret: { type: 'recovery', code: fx.recoveryCode.toLowerCase().replace(/(.{8})/g, '$1 ') } }));
    const state = await stateOf(w);
    expect(state.phase).toBe('unlocked');
    const byType = Object.fromEntries(state.methods.map((m: any) => [m.type, m]));
    expect(byType.recovery.usedAt).toBe(new Date(T0 + 5000).toISOString());
    expect(byType.passkey.lastUsedAt).toBeNull();
  });

  it('a security key unlocks and sets its lastUsedAt', async () => {
    const w = lockedWorld();
    w.clock.t = T0 + 7000;
    expectOk(await w.send({ type: 'unlock', secret: passkeySecret() }));
    const state = await stateOf(w);
    expect(state.phase).toBe('unlocked');
    const byType = Object.fromEntries(state.methods.map((m: any) => [m.type, m]));
    expect(byType.passkey.lastUsedAt).toBe(new Date(T0 + 7000).toISOString());
    expect(byType.recovery.usedAt).toBeNull();
  });

  it('a secret that cannot be read is refused with invalid, so the page still gets an answer', async () => {
    const w = lockedWorld();
    expectError(await w.send({ type: 'unlock', secret: { type: 'passkey', credentialId: fx.passkey.credentialId, prfOutput: '%%%' } }), 'invalid', 'That is not valid.');
    expect((await stateOf(w)).phase).toBe('locked');
  });
});

describe('password lockout', () => {
  const wrong = { type: 'password', password: OTHER_PASSWORD };
  const right = { type: 'password', password: PASSWORD };

  it(
    'five wrong passwords in a row lock the password out for 5 minutes, even the right one',
    async () => {
      const w = lockedWorld();
      for (let i = 0; i < 4; i += 1) {
        expectError(await w.send({ type: 'unlock', secret: wrong }), 'wrong-secret', WRONG_PASSWORD_MESSAGE);
      }
      expect((await stateOf(w)).passwordLockedUntil).toBeNull();
      expectError(await w.send({ type: 'unlock', secret: wrong }), 'password-locked-out', 'Too many wrong passwords. Try again in 5 minutes.');
      expect(w.chrome.local.data[LOCKOUT_KEY]).toEqual({ failures: 0, lockedUntil: T0 + PASSWORD_LOCKOUT_MS });
      expect((await stateOf(w)).passwordLockedUntil).toBe(T0 + PASSWORD_LOCKOUT_MS);

      w.clock.t = T0 + PASSWORD_LOCKOUT_MS - 1;
      expectError(await w.send({ type: 'unlock', secret: right }), 'password-locked-out');
      expect((await stateOf(w)).phase).toBe('locked');

      w.clock.t = T0 + PASSWORD_LOCKOUT_MS;
      expect((await stateOf(w)).passwordLockedUntil).toBeNull();
      expectOk(await w.send({ type: 'unlock', secret: right }));
      expect((await stateOf(w)).phase).toBe('unlocked');
    },
    SLOW,
  );

  it(
    'a right password resets the count of wrong ones',
    async () => {
      const w = lockedWorld();
      for (let i = 0; i < 4; i += 1) {
        expectError(await w.send({ type: 'unlock', secret: wrong }), 'wrong-secret');
      }
      expectOk(await w.send({ type: 'unlock', secret: right }));
      expectOk(await w.send({ type: 'lock' }));
      for (let i = 0; i < 4; i += 1) {
        expectError(await w.send({ type: 'unlock', secret: wrong }), 'wrong-secret');
      }
      expect(w.chrome.local.data[LOCKOUT_KEY]).toEqual({ failures: 4, lockedUntil: null });
    },
    SLOW,
  );

  it(
    'the recovery code still unlocks while the password is locked out',
    async () => {
      const w = lockedWorld();
      for (let i = 0; i < 5; i += 1) {
        await w.send({ type: 'unlock', secret: wrong });
      }
      expectOk(await w.send({ type: 'unlock', secret: recoverySecret() }));
      expect((await stateOf(w)).phase).toBe('unlocked');
    },
    SLOW,
  );
});

describe('lock', () => {
  it('Lock clears the session, keeps the reason and tells every tab with a content script', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'lock' }));
    expect(w.chrome.session.data).toEqual({ [LOCK_REASON_KEY]: 'manual' });
    expect(await stateOf(w)).toMatchObject({ phase: 'locked', lockReason: 'manual', lastCheckAt: null, peopleCount: null });
    expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
    expect(await w.send({ type: 'lookupNames', ids: ['macc1'] }, CONTENT_SENDER)).toEqual({ ok: true, phase: 'locked', names: {} });
  });

  it('after Chrome restarts the list is locked with no reason', async () => {
    const w = lockedWorld();
    expect(await stateOf(w)).toMatchObject({ phase: 'locked', lockReason: null });
  });

  it.each([
    ['idle', true, 'idle'],
    ['idle', false, 'idle'],
    ['locked', true, 'pc-locked'],
    ['locked', false, null],
    ['active', true, null],
  ])('the idle state "%s" with "Lock when this PC locks" %s locks with reason %s', async (idleState, lockWhenPcLocks, reason) => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'setSettings', lockWhenPcLocks }));
    await w.bg.onIdleState(idleState);
    const state = await stateOf(w);
    if (reason === null) {
      expect(state.phase).toBe('unlocked');
      expect(w.chrome.sent).toEqual([]);
    } else {
      expect(state).toMatchObject({ phase: 'locked', lockReason: reason });
      expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
    }
  });

  it('the idle state after the chosen minutes locks the list', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'setSettings', autoLockMinutes: 5 }));
    expect(w.chrome.idleIntervals).toEqual([300]);
    await w.bg.onIdleState('idle');
    expect(await stateOf(w)).toMatchObject({ phase: 'locked', lockReason: 'idle' });
  });

  it.each([
    ['locks the list when the PC was locked for the chosen minutes', 15 * 60_000, 'locked'],
    ['keeps the list unlocked when the PC was locked for less', 15 * 60_000 - 1, 'unlocked'],
  ])('with "Lock when this PC locks" off, a return to active %s', async (_label, lockedFor, phase) => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'setSettings', lockWhenPcLocks: false, autoLockMinutes: 15 }));
    await w.bg.onIdleState('locked');
    w.clock.t += lockedFor;
    await w.bg.onIdleState('active');
    const state = await stateOf(w);
    expect(state.phase).toBe(phase);
    if (phase === 'locked') {
      expect(state.lockReason).toBe('idle');
    }
    expect(w.chrome.session.data[PC_LOCKED_AT_KEY]).toBeUndefined();
  });

  it('a return to active with no PC lock before it changes nothing', async () => {
    const w = unlockedWorld();
    w.clock.t += 24 * 60 * 60_000;
    await w.bg.onIdleState('active');
    expect((await stateOf(w)).phase).toBe('unlocked');
  });

  it('an idle state while the list is already locked changes nothing', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'lock' }));
    w.chrome.sent.length = 0;
    await w.bg.onIdleState('idle');
    expect((await stateOf(w)).lockReason).toBe('manual');
    expect(w.chrome.sent).toEqual([]);
  });
});

describe('the check in the last 5 minutes', () => {
  const GUARDED: [string, () => object][] = [
    ['deleteAll', () => ({ type: 'deleteAll' })],
    ['exportBackup', () => ({ type: 'exportBackup' })],
    ['addPasskey', () => ({ type: 'addPasskey', passkey: passkeyMessage() })],
    ['setPassword', () => ({ type: 'setPassword', password: OTHER_PASSWORD })],
    ['removeMethod', () => ({ type: 'removeMethod', id: fx.ids.passkey })],
    ['newRecoveryCode', () => ({ type: 'newRecoveryCode' })],
  ];

  it.each(GUARDED)('%s is refused 301 seconds after the last check', async (_type, request) => {
    const w = unlockedWorld();
    w.clock.t = T0 + 301_000;
    expectError(await w.send(request()), 'check-needed', 'Confirm it is you first.');
  });

  it.each(GUARDED)(
    '%s runs 299 seconds after the last check',
    async (_type, request) => {
      const w = unlockedWorld();
      w.clock.t = T0 + 299_000;
      expectOk(await w.send(request()));
    },
    SLOW,
  );

  it('the window is exactly 300 seconds', () => {
    expect(CHECK_WINDOW_MS).toBe(300_000);
  });

  it('a check with the right secret starts the window again and marks the method used', async () => {
    const w = unlockedWorld();
    w.clock.t = T0 + 301_000;
    expectOk(await w.send({ type: 'check', secret: passkeySecret() }));
    const state = await stateOf(w);
    expect(state.lastCheckAt).toBe(T0 + 301_000);
    expect(state.methods.find((m: any) => m.type === 'passkey').lastUsedAt).toBe(new Date(T0 + 301_000).toISOString());
    expectOk(await w.send({ type: 'exportBackup' }));
  });

  it('a check with a wrong secret keeps the old check time', async () => {
    const w = unlockedWorld();
    w.clock.t = T0 + 301_000;
    expectError(await w.send({ type: 'check', secret: { type: 'recovery', code: makeRecoveryCode() } }), 'wrong-secret', WRONG_RECOVERY_MESSAGE);
    expect((await stateOf(w)).lastCheckAt).toBe(T0);
    expectError(await w.send({ type: 'exportBackup' }), 'check-needed');
  });
});

describe('unlock methods', () => {
  it.each([
    ['an unknown id', () => 'nope'],
    ['the recovery code', () => fx.ids.recovery],
  ])('removing %s is refused with not-found', async (_label, id) => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'removeMethod', id: id() }), 'not-found', 'That was not found.');
    expect((await stateOf(w)).methods).toHaveLength(3);
  });

  it('a method can be removed until it is the last way to unlock', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'removeMethod', id: fx.ids.passkey }));
    expect((await stateOf(w)).methods.map((m: any) => m.type)).toEqual(['password', 'recovery']);
    expectError(await w.send({ type: 'removeMethod', id: fx.ids.password }), 'last-method', 'The last way to unlock the list cannot be removed.');
    expect((await stateOf(w)).methods.map((m: any) => m.type)).toEqual(['password', 'recovery']);
  });

  it('a new security key opens the list', async () => {
    const w = unlockedWorld();
    const passkey = passkeyMessage({ name: 'Spare key' });
    expectOk(await w.send({ type: 'addPasskey', passkey }));
    expect((await stateOf(w)).methods.map((m: any) => m.name).filter(Boolean)).toEqual(['YubiKey', 'Spare key']);
    expectOk(await w.send({ type: 'lock' }));
    expectOk(await w.send({ type: 'unlock', secret: { type: 'passkey', credentialId: passkey.credentialId, prfOutput: passkey.prfOutput } }));
  });

  it('an invalid new security key is refused', async () => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'addPasskey', passkey: passkeyMessage({ kind: 'other' }) }), 'invalid');
  });

  it(
    'a new password replaces the old one',
    async () => {
      const w = unlockedWorld();
      expectOk(await w.send({ type: 'setPassword', password: OTHER_PASSWORD }));
      expect((await stateOf(w)).methods.filter((m: any) => m.type === 'password')).toHaveLength(1);
      expectOk(await w.send({ type: 'lock' }));
      expectError(await w.send({ type: 'unlock', secret: { type: 'password', password: PASSWORD } }), 'wrong-secret', WRONG_PASSWORD_MESSAGE);
      expectOk(await w.send({ type: 'unlock', secret: { type: 'password', password: OTHER_PASSWORD } }));
    },
    SLOW,
  );

  it('a weak new password is refused before the check is asked for', async () => {
    const w = unlockedWorld();
    w.clock.t = T0 + 301_000;
    expectError(await w.send({ type: 'setPassword', password: 'short' }), 'invalid');
  });

  it('a new recovery code works and the old one stops working', async () => {
    const w = unlockedWorld();
    const { code } = expectOk(await w.send({ type: 'newRecoveryCode' }));
    expect(code).not.toBe(fx.recoveryCode);
    expect((await stateOf(w)).methods.filter((m: any) => m.type === 'recovery')).toHaveLength(1);
    expectOk(await w.send({ type: 'lock' }));
    expectError(await w.send({ type: 'unlock', secret: recoverySecret() }), 'wrong-secret', WRONG_RECOVERY_MESSAGE);
    expectOk(await w.send({ type: 'unlock', secret: { type: 'recovery', code } }));
  });
});

describe('the list', () => {
  it('getPeople returns the list sorted by name, or by username when there is no name', async () => {
    const w = unlockedWorld();
    const people = await peopleOf(w);
    expect(people.map((p) => p.name || p.username)).toEqual(['Bob Stone', 'Jane Example', 'Mnew']);
    expect(people.find((p) => p.username === 'macc1')).toMatchObject({ email: 'jane@example.org', kind: 'member' });
  });

  it('addPerson adds a username and an email, with no name, and tells every tab', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'addPerson', username: ' Mzed ', email: ' zed@example.org ' }));
    expect((await peopleOf(w)).find((p) => p.username === 'Mzed')).toEqual({
      username: 'Mzed',
      name: '',
      email: 'zed@example.org',
      phone: '',
      address: '',
      postcode: '',
      kind: '',
    });
    expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
  });

  it.each([
    ['a blank username', { username: '  ', email: 'zed@example.org' }, MISSING_USERNAME_MESSAGE],
    ['no username', { email: 'zed@example.org' }, MISSING_USERNAME_MESSAGE],
    ['an email with no @', { username: 'Mzed', email: 'zed.example.org' }, MISSING_EMAIL_MESSAGE],
    ['no email', { username: 'Mzed' }, MISSING_EMAIL_MESSAGE],
    ['a username already in the list', { username: 'MACC1', email: 'zed@example.org' }, DUPLICATE_USERNAME_MESSAGE],
  ])('addPerson with %s is refused', async (_label, fields, message) => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'addPerson', ...fields }), 'invalid', message);
    expect(await peopleOf(w)).toHaveLength(3);
  });

  it('renameUser changes the username only', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'renameUser', from: 'MBOB', to: 'Mrobert' }));
    const people = await peopleOf(w);
    expect(people.find((p) => p.username === 'Mrobert')).toMatchObject({ name: 'Bob Stone', email: 'bob@example.org' });
    expect(people.some((p) => p.username === 'Mbob')).toBe(false);
  });

  it.each([
    ['an unknown username', { from: 'nobody', to: 'Mx' }, 'not-found', 'That was not found.'],
    ['no username to change', { to: 'Mx' }, 'not-found', 'That was not found.'],
    ['a new username already in the list', { from: 'mbob', to: 'Macc1' }, 'invalid', DUPLICATE_USERNAME_MESSAGE],
    ['no new username', { from: 'mbob' }, 'invalid', MISSING_USERNAME_MESSAGE],
  ])('renameUser with %s is refused and the list does not change', async (_label, fields, error, message) => {
    const w = unlockedWorld();
    const before = await peopleOf(w);
    expectError(await w.send({ type: 'renameUser', ...fields }), error, message);
    expect(await peopleOf(w)).toEqual(before);
  });

  it('deletePerson removes the row', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'deletePerson', username: 'mbob' }));
    expect((await peopleOf(w)).map((p) => p.username)).toEqual(['macc1', 'Mnew']);
  });

  it('deletePerson with no username removes nothing', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'deletePerson' }));
    expect(await peopleOf(w)).toHaveLength(3);
  });

  it('deleteAll empties the list', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'deleteAll' }));
    expect(await peopleOf(w)).toEqual([]);
    expect((await stateOf(w)).peopleCount).toBe(0);
  });

  it.each(VAULT_REQUESTS.filter(([type]) => type !== 'unlock'))('%s while locked is refused with locked', async (_type, request) => {
    const w = lockedWorld();
    expectError(await w.send(request()), 'locked', 'Unlock the list first.');
  });
});

describe('import and backup', () => {
  it('previewImport reads a people CSV and writes nothing', async () => {
    const w = unlockedWorld();
    const vaultBefore = JSON.stringify(w.chrome.local.data[VAULT_KEY]);
    const { preview } = expectOk(await w.send({ type: 'previewImport', text: 'username,name\nMnew,New Person\nMzed,Zed Ze' }));
    expect(preview).toMatchObject({ kind: 'people', label: 'CSV with usernames', rowCount: 2 });
    expect(preview.imported.map((p: any) => p.username)).toEqual(['Mnew', 'Mzed']);
    expect(JSON.stringify(w.chrome.local.data[VAULT_KEY])).toBe(vaultBefore);
  });

  it('previewImport matches a NationBuilder member import row by email', async () => {
    const w = unlockedWorld();
    const { preview } = expectOk(await w.send({ type: 'previewImport', text: NB_MEMBER_CSV }));
    expect(preview).toMatchObject({ kind: 'nationbuilder', format: 'nb-member', label: 'NationBuilder Export · member import format', rowCount: 1 });
    expect(preview.plan.matched[0]).toMatchObject({ username: 'macc1', name: 'Jane Example' });
  });

  it('applyImport of a NationBuilder CSV changes only the ticked fields', async () => {
    const w = unlockedWorld();
    const { result } = expectOk(await w.send({ type: 'applyImport', text: NB_MEMBER_CSV, fields: ['name'] }));
    expect(result).toMatchObject({ kind: 'nationbuilder', updated: 1, unchanged: 0 });
    expect((await peopleOf(w)).find((p) => p.username === 'macc1')).toMatchObject({ name: 'Jane A. Example', phone: '', postcode: '' });
    expect(refreshTabs(w.chrome)).toEqual([1, TAB_WITHOUT_CONTENT_SCRIPT]);
  });

  it('applyImport with no list of fields changes no detail', async () => {
    const w = unlockedWorld();
    const { result } = expectOk(await w.send({ type: 'applyImport', text: NB_MEMBER_CSV }));
    expect(result).toMatchObject({ kind: 'nationbuilder', updated: 0, unchanged: 1 });
    expect((await peopleOf(w)).find((p) => p.username === 'macc1')!.name).toBe('Jane Example');
  });

  it.each([
    ['previewImport', undefined],
    ['previewImport', ''],
    ['previewImport', 'foo,bar\n1,2'],
    ['applyImport', undefined],
  ])('%s of the text %j is refused because the file has no id column', async (type, text) => {
    const w = unlockedWorld();
    expectError(await w.send({ type, text, fields: [] }), 'invalid', MISSING_ID_COLUMN_MESSAGE);
  });

  it('exportBackup returns a dated .ztbackup file with no plain values and sets lastBackupAt', async () => {
    const w = unlockedWorld();
    const { fileName, text } = expectOk(await w.send({ type: 'exportBackup' }));
    expect(fileName).toBe('zero-trust-translator-2026-11-06.ztbackup');
    expect(JSON.parse(text)).toMatchObject({ format: 'zt-backup', version: 1 });
    for (const value of PLAIN_VALUES) {
      expect(text).not.toContain(value);
    }
    expect((await stateOf(w)).settings.lastBackupAt).toBe(new Date(T0).toISOString());
  });

  it('importBackup with the recovery code adds the people back, then finds them unchanged', async () => {
    const w = unlockedWorld();
    const { text } = expectOk(await w.send({ type: 'exportBackup' }));
    expectOk(await w.send({ type: 'deleteAll' }));
    const first = expectOk(await w.send({ type: 'importBackup', text, secret: recoverySecret() }));
    expect(first.result).toEqual({ kind: 'backup', added: 3, updated: 0, unchanged: 0, skipped: [] });
    expect(await peopleOf(w)).toHaveLength(3);
    const second = expectOk(await w.send({ type: 'importBackup', text, secret: passkeySecret() }));
    expect(second.result).toEqual({ kind: 'backup', added: 0, updated: 0, unchanged: 3, skipped: [] });
  });

  it.each([
    ['a wrong password', () => ({ type: 'password', password: OTHER_PASSWORD }), WRONG_PASSWORD_MESSAGE],
    ['a wrong recovery code', () => ({ type: 'recovery', code: makeRecoveryCode() }), WRONG_RECOVERY_MESSAGE],
    ['a wrong key', () => ({ type: 'passkey', credentialId: fx.passkey.credentialId, prfOutput: toBase64(randomBytes(32)) }), WRONG_PASSKEY_MESSAGE],
  ])(
    'importBackup with %s is refused and the list does not change',
    async (_label, secret, message) => {
      const w = unlockedWorld();
      const { text } = expectOk(await w.send({ type: 'exportBackup' }));
      expectOk(await w.send({ type: 'deleteAll' }));
      expectError(await w.send({ type: 'importBackup', text, secret: secret() }), 'wrong-secret', message);
      expect(await peopleOf(w)).toEqual([]);
    },
    SLOW,
  );

  it.each([
    ['text that is not JSON', 'username,name\nMacc1,Jane'],
    ['JSON of another format', '{"format":"other","version":1}'],
    ['no text', undefined],
  ])('importBackup of %s is refused with bad-file', async (_label, text) => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'importBackup', text, secret: recoverySecret() }), 'bad-file', BAD_FILE_MESSAGE);
  });

  it('importBackup with a secret that is not base64 is refused with invalid', async () => {
    const w = unlockedWorld();
    const { text } = expectOk(await w.send({ type: 'exportBackup' }));
    expectError(await w.send({ type: 'importBackup', text, secret: { type: 'passkey', credentialId: fx.passkey.credentialId, prfOutput: '%%%' } }), 'invalid', 'That is not valid.');
  });
});

describe('settings', () => {
  it.each([5, 15, 60, 240])('auto-lock after %i minutes is accepted and sets the idle interval', async (minutes) => {
    const w = unlockedWorld();
    const { settings } = expectOk(await w.send({ type: 'setSettings', autoLockMinutes: minutes }));
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, autoLockMinutes: minutes });
    expect((await stateOf(w)).settings.autoLockMinutes).toBe(minutes);
    expect(w.chrome.idleIntervals).toEqual([minutes * 60]);
  });

  it.each([7, 0, '15', null])('auto-lock after %j minutes is refused and the settings do not change', async (minutes) => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'setSettings', autoLockMinutes: minutes }), 'invalid', 'That is not valid.');
    expect((await stateOf(w)).settings).toEqual(DEFAULT_SETTINGS);
    expect(w.chrome.idleIntervals).toEqual([]);
  });

  it.each([
    [false, false],
    ['yes', false],
    [true, true],
  ])('"Lock when this PC locks" sent as %j is saved as %s and keeps the auto-lock minutes', async (value, saved) => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'setSettings', autoLockMinutes: 60 }));
    expectOk(await w.send({ type: 'setSettings', lockWhenPcLocks: value }));
    expect((await stateOf(w)).settings).toEqual({ ...DEFAULT_SETTINGS, autoLockMinutes: 60, lockWhenPcLocks: saved });
  });

  it('setSettings with no change keeps every setting', async () => {
    const w = unlockedWorld();
    expectOk(await w.send({ type: 'setSettings', lockWhenPcLocks: false }));
    expectOk(await w.send({ type: 'setSettings' }));
    expect((await stateOf(w)).settings).toEqual({ ...DEFAULT_SETTINGS, lockWhenPcLocks: false });
  });
});

describe('names for the content script', () => {
  it('returns the names of the asked usernames only, and none for a person with no name', async () => {
    const w = unlockedWorld();
    const response = await w.send({ type: 'lookupNames', ids: [' MACC1 ', 'mbob', 'mnew', 'nobody', 5] }, CONTENT_SENDER);
    expect(response).toEqual({ ok: true, phase: 'unlocked', names: { macc1: 'Jane Example', mbob: 'Bob Stone' } });
  });

  it('returns no names when the ids are not a list', async () => {
    const w = unlockedWorld();
    expect(await w.send({ type: 'lookupNames', ids: 'macc1' }, CONTENT_SENDER)).toEqual({ ok: true, phase: 'unlocked', names: {} });
  });
});

describe('sender checks', () => {
  const forbidden = { ok: false, error: 'forbidden', message: 'This request is not allowed.' };

  it.each([
    ['another extension asks for names', { type: 'lookupNames', ids: ['macc1'] }, { id: 'otherextension', url: 'chrome-extension://otherextension/popup.html' }],
    ['another extension asks for the state', { type: 'getState' }, { id: 'otherextension', url: `${EXTENSION_ORIGIN}popup.html` }],
    ['a content script asks for the people', { type: 'getPeople' }, CONTENT_SENDER],
    ['a content script asks to lock', { type: 'lock' }, CONTENT_SENDER],
    ['a sender with no url asks for the state', { type: 'getState' }, { id: EXTENSION_ID }],
    ['the request is empty', null, PAGE_SENDER],
    ['the request is text', 'getState', PAGE_SENDER],
  ])('%s: refused with forbidden', async (_label, request, sender) => {
    const w = unlockedWorld();
    expect(await w.send(request, sender)).toEqual(forbidden);
    expect((await stateOf(w)).phase).toBe('unlocked');
  });

  it('an unknown request type is refused with invalid', async () => {
    const w = unlockedWorld();
    expectError(await w.send({ type: 'sendEverything' }), 'invalid', 'That is not valid.');
  });
});

describe('the ceremony port', () => {
  it.each([
    ['unlock', 'platform'],
    ['check', 'cross-platform'],
    ['setup', 'platform'],
    ['add', 'cross-platform'],
  ])('a page that closes during a %s dialog for a %s key reopens it in unlock.html', (op, kind) => {
    const w = world();
    const port = makePort(CEREMONY_PORT);
    w.bg.onCeremonyPort(port);
    port.post({ op, kind });
    port.disconnect();
    expect(w.chrome.created).toEqual([`${EXTENSION_ORIGIN}unlock.html?op=${op}&kind=${kind}`]);
  });

  it.each([
    ['the page said the dialog ended', CEREMONY_PORT, [{ op: 'unlock', kind: 'platform' }, { done: true }]],
    ['the port has another name', 'other-port', [{ op: 'unlock', kind: 'platform' }]],
    ['the message is empty', CEREMONY_PORT, [null]],
    ['the op is unknown', CEREMONY_PORT, [{ op: 'export', kind: 'platform' }]],
    ['the kind is unknown', CEREMONY_PORT, [{ op: 'unlock', kind: 'hybrid' }]],
    ['no message came', CEREMONY_PORT, []],
  ])('no tab opens when %s', (_label, name, messages) => {
    const w = world();
    const port = makePort(name);
    w.bg.onCeremonyPort(port);
    for (const message of messages) {
      port.post(message);
    }
    port.disconnect();
    expect(w.chrome.created).toEqual([]);
  });
});

describe('installBackground', () => {
  it('registers the message, port and idle listeners and starts the worker', async () => {
    const chrome = FakeChrome.from(fx.unlocked);
    installBackground(chrome.api);
    await vi.waitFor(() => expect(chrome.idleIntervals).toEqual([900]));
    expect(chrome.session.accessLevels).toEqual(['TRUSTED_CONTEXTS']);

    const sendResponse = vi.fn();
    expect(chrome.messageListeners[0]!({ type: 'getState' }, PAGE_SENDER, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse.mock.calls[0]![0]).toMatchObject({ ok: true, state: { phase: 'unlocked' } });

    const port = makePort(CEREMONY_PORT);
    chrome.connectListeners[0]!(port);
    port.post({ op: 'unlock', kind: 'platform' });
    port.disconnect();
    expect(chrome.created).toEqual([`${EXTENSION_ORIGIN}unlock.html?op=unlock&kind=platform`]);

    chrome.idleListeners[0]!('idle');
    await vi.waitFor(() => expect(chrome.session.data).toEqual({ [LOCK_REASON_KEY]: 'idle' }));
  });
});
