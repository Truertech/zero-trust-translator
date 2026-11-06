/**
 * The page helpers of `src/ui.ts` that hold no DOM: the date and count
 * texts, the 5-minute check, the method filters, the WebAuthn error text,
 * `call`, `withCeremony` and the passkey list given to the authenticator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CEREMONY_PORT, type MethodView, type StateView } from '../../src/messages';
import {
  RequestFailed,
  autoLockLabel,
  call,
  ceremonyError,
  checkIsRecent,
  formatDay,
  hasPassword,
  minutesAgo,
  passkeySecret,
  passkeys,
  peopleLabel,
  withCeremony,
} from '../../src/ui';
import { NO_PRF_MESSAGE, NoPrfError, assertPasskey } from '../../src/webauthn';

vi.mock('../../src/webauthn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/webauthn')>()),
  assertPasskey: vi.fn(),
  registerPasskey: vi.fn(),
}));

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const DAY = 86_400_000;

const PASSWORD: MethodView = { id: 'p', type: 'password', createdAt: '2026-11-01T00:00:00.000Z' };
const HELLO: MethodView = { id: 'h', type: 'passkey', kind: 'platform', createdAt: '2026-11-01T00:00:00.000Z', credentialId: 'hello-id', prfSalt: 'hello-salt' };
const KEY: MethodView = { id: 'k', type: 'passkey', kind: 'cross-platform', createdAt: '2026-11-01T00:00:00.000Z', credentialId: 'key-id', prfSalt: 'key-salt' };
const BARE_KEY: MethodView = { id: 'b', type: 'passkey', kind: 'cross-platform', createdAt: '2026-11-01T00:00:00.000Z' };
const RECOVERY: MethodView = { id: 'r', type: 'recovery', createdAt: '2026-11-01T00:00:00.000Z' };

function state(fields: Partial<StateView>): StateView {
  return { methods: [], lastCheckAt: null, now: NOW, ...fields } as StateView;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(assertPasskey).mockReset();
});

describe('formatDay', () => {
  it('says today for a time earlier on the same day', () => {
    expect(formatDay(new Date(NOW - 60_000).toISOString(), NOW)).toBe('today');
  });

  it('says yesterday for a time on the day before', () => {
    expect(formatDay(new Date(NOW - DAY).toISOString(), NOW)).toBe('yesterday');
  });

  it('gives the date for a time two days before', () => {
    expect(formatDay(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe('4 Nov 2026');
  });
});

describe('minutesAgo', () => {
  it.each([
    [59_999, 'just now'],
    [60_000, '1 minute ago'],
    [119_999, '1 minute ago'],
    [120_000, '2 minutes ago'],
    [22 * 60_000, '22 minutes ago'],
  ])('%i ms ago is "%s"', (ago, text) => {
    expect(minutesAgo(NOW - ago, NOW)).toBe(text);
  });
});

describe('autoLockLabel', () => {
  it.each([
    [5, '5 min'],
    [15, '15 min'],
    [60, '1 hour'],
    [240, '4 hours'],
  ])('%i minutes is "%s"', (minutes, text) => {
    expect(autoLockLabel(minutes)).toBe(text);
  });
});

describe('peopleLabel', () => {
  it.each([
    [0, '0 people'],
    [1, '1 person'],
    [2, '2 people'],
  ])('%i is "%s"', (count, text) => {
    expect(peopleLabel(count)).toBe(text);
  });
});

describe('checkIsRecent', () => {
  it.each([
    ['no check yet', null, false],
    ['a check now', NOW, true],
    ['a check exactly 300 seconds ago', NOW - 300_000, true],
    ['a check 300,001 ms ago', NOW - 300_001, false],
  ])('%s gives %s', (_label, lastCheckAt, recent) => {
    expect(checkIsRecent(state({ lastCheckAt }))).toBe(recent);
  });
});

describe('passkeys and hasPassword', () => {
  const all = state({ methods: [PASSWORD, HELLO, KEY, RECOVERY] });

  it('passkeys with no kind gives every passkey and no other method', () => {
    expect(passkeys(all)).toEqual([HELLO, KEY]);
  });

  it('passkeys with a kind gives the passkeys of that kind only', () => {
    expect(passkeys(all, 'platform')).toEqual([HELLO]);
    expect(passkeys(all, 'cross-platform')).toEqual([KEY]);
    expect(passkeys(state({ methods: [PASSWORD, KEY] }), 'platform')).toEqual([]);
  });

  it('hasPassword is true only when a password method is set up', () => {
    expect(hasPassword(all)).toBe(true);
    expect(hasPassword(state({ methods: [HELLO, RECOVERY] }))).toBe(false);
  });
});

describe('ceremonyError', () => {
  it.each([
    ['a NoPrfError', new NoPrfError(), NO_PRF_MESSAGE],
    ['a NotAllowedError', new DOMException('x', 'NotAllowedError'), 'The check was cancelled or timed out. Try again.'],
    ['an AbortError', new DOMException('x', 'AbortError'), 'The check was cancelled or timed out. Try again.'],
    ['an InvalidStateError', new DOMException('x', 'InvalidStateError'), 'This key is already set up.'],
    ['a DOMException with another name', new DOMException('Security problem', 'SecurityError'), 'Security problem'],
    ['an Error', new Error('Something failed'), 'Something failed'],
    ['a value that is not an Error', 'plain text', 'plain text'],
  ])('gives the right text for %s', (_label, error, text) => {
    expect(ceremonyError(error)).toBe(text);
  });
});

describe('call', () => {
  it('returns the response when it is ok', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, people: [] });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(call({ type: 'getPeople' })).resolves.toEqual({ ok: true, people: [] });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'getPeople' });
  });

  it('throws RequestFailed with the code and the message when it is not ok', async () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: 'locked', message: 'The list is locked.' }) } });
    const error = await call({ type: 'getPeople' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({ code: 'locked', message: 'The list is locked.' });
  });
});

describe('withCeremony', () => {
  function stubPort(): { connect: ReturnType<typeof vi.fn>; posted: unknown[]; disconnect: ReturnType<typeof vi.fn> } {
    const posted: unknown[] = [];
    const disconnect = vi.fn();
    const connect = vi.fn(() => ({ postMessage: (m: unknown) => posted.push(m), disconnect }));
    vi.stubGlobal('chrome', { runtime: { connect } });
    return { connect, posted, disconnect };
  }

  it('opens the ceremony port, says what the dialog is for, then says it ended and closes the port', async () => {
    const port = stubPort();
    await expect(withCeremony('unlock', 'platform', async () => 'done')).resolves.toBe('done');
    expect(port.connect).toHaveBeenCalledWith({ name: CEREMONY_PORT });
    expect(port.posted).toEqual([{ op: 'unlock', kind: 'platform' }, { done: true }]);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('still says the dialog ended and closes the port when the dialog fails', async () => {
    const port = stubPort();
    await expect(withCeremony('check', 'cross-platform', async () => Promise.reject(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(port.posted).toEqual([{ op: 'check', kind: 'cross-platform' }, { done: true }]);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('passkeySecret', () => {
  it('asks the authenticator for the passkeys of the chosen kind only, with an empty id or salt where one is missing', async () => {
    vi.mocked(assertPasskey).mockResolvedValue({ credentialId: 'key-id', prfOutput: 'out' });
    const secret = await passkeySecret(state({ methods: [PASSWORD, HELLO, KEY, BARE_KEY] }), 'cross-platform');
    expect(assertPasskey).toHaveBeenCalledWith([
      { credentialId: 'key-id', prfSalt: 'key-salt' },
      { credentialId: '', prfSalt: '' },
    ]);
    expect(secret).toEqual({ type: 'passkey', credentialId: 'key-id', prfOutput: 'out' });
  });
});
