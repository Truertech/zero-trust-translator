import { describe, expect, it, vi } from 'vitest';
import type { StateView } from '../../src/messages';
import { CeremonyBusyError, newPasskey, passkeySecret } from '../../src/ui';
import { assertPasskey, registerPasskey } from '../../src/webauthn';

vi.mock('../../src/webauthn', () => ({
  assertPasskey: vi.fn(),
  registerPasskey: vi.fn(),
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const STATE: StateView = {
  phase: 'unlocked',
  version: '1.0.5',
  methods: [{ id: 'm1', type: 'passkey', kind: 'platform', createdAt: '2026-11-06T00:00:00.000Z', credentialId: 'c1', prfSalt: 's1' }],
  settings: { autoLockMinutes: 5, lockWhenPcLocks: true, lastBackupAt: null },
  lockReason: null,
  passwordLockedUntil: null,
  lastCheckAt: null,
  now: Date.now(),
} as unknown as StateView;

describe('passkeySecret and newPasskey, locked to one ceremony at a time', () => {
  it('throws CeremonyBusyError for a second passkeySecret call while the first is pending, without asking the authenticator again', async () => {
    const assertMock = vi.mocked(assertPasskey);
    const first = deferred<{ credentialId: string; prfOutput: string }>();
    assertMock.mockReturnValueOnce(first.promise);

    const firstCall = passkeySecret(STATE, 'platform');
    await expect(passkeySecret(STATE, 'platform')).rejects.toBeInstanceOf(CeremonyBusyError);
    expect(assertMock).toHaveBeenCalledTimes(1);

    first.resolve({ credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0' });
    await firstCall;
  });

  it('releases the lock after the first call settles, so a later call succeeds', async () => {
    const assertMock = vi.mocked(assertPasskey);
    assertMock.mockResolvedValueOnce({ credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0' });
    await passkeySecret(STATE, 'platform');

    assertMock.mockResolvedValueOnce({ credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0Mg==' });
    await expect(passkeySecret(STATE, 'platform')).resolves.toEqual({ type: 'passkey', credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0Mg==' });
  });

  it('releases the lock after the first call fails, so a later call still succeeds', async () => {
    const assertMock = vi.mocked(assertPasskey);
    assertMock.mockRejectedValueOnce(new Error('cancelled'));
    await expect(passkeySecret(STATE, 'platform')).rejects.toThrow('cancelled');

    assertMock.mockResolvedValueOnce({ credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0Mw==' });
    await expect(passkeySecret(STATE, 'platform')).resolves.toEqual({ type: 'passkey', credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0Mw==' });
  });

  it('shares the one-ceremony lock between passkeySecret and newPasskey', async () => {
    const assertMock = vi.mocked(assertPasskey);
    const registerMock = vi.mocked(registerPasskey);
    const first = deferred<{ credentialId: string; prfOutput: string }>();
    assertMock.mockReturnValueOnce(first.promise);

    const firstCall = passkeySecret(STATE, 'platform');
    await expect(newPasskey('platform', 'Windows Hello')).rejects.toBeInstanceOf(CeremonyBusyError);
    expect(registerMock).not.toHaveBeenCalled();

    first.resolve({ credentialId: 'c1', prfOutput: 'cHJmb3V0cHV0' });
    await firstCall;
  });
});
