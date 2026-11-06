import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyPerson, type PersonRecord } from '../../src/types';
import {
  BackupFormatError,
  IV_BYTES,
  PBKDF2_ITERATIONS,
  RECOVERY_BYTES,
  SALT_BYTES,
  WrongSecretError,
  fromBase64,
  fromBase64Url,
  makeBackup,
  makePasskeyMethod,
  makePasswordMethod,
  makeRawDataKey,
  makeRecoveryCode,
  makeRecoveryMethod,
  normaliseRecoveryCode,
  openBackup,
  openList,
  openPasskeyMethod,
  openPasswordMethod,
  openRecoveryMethod,
  openWithSecret,
  parseBackup,
  randomBytes,
  recoveryCodeGroups,
  sealList,
  toBase64,
  toBase64Url,
  type Bytes,
  type NewPasskey,
  type PasswordMethod,
  type RecoveryMethod,
  type Sealed,
} from '../../src/vault';

const PBKDF2_TIMEOUT = 30_000;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const PASSWORD = 'café-tangerine-owl'; // é composed (NFC)
const CODE = 'ABCDEFGH0123456789JKMNPQRSTVWXYZ';

const people: PersonRecord[] = [{ ...emptyPerson('Macc1'), name: 'Jane Example', email: 'jane@example.org' }];

function bytes(...values: number[]): Bytes {
  return new Uint8Array(values);
}

function passkey(kind: NewPasskey['kind'], credentialId: string, prfOutput: Bytes): NewPasskey {
  return { kind, name: `${kind} key`, credentialId, prfSalt: toBase64(randomBytes(32)), prfOutput, transports: ['usb'] };
}

/** Flips one bit of a base64 value. */
function tamper(text: string): string {
  const raw = fromBase64(text);
  raw[0] = raw[0]! ^ 1;
  return toBase64(raw);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('base64 and base64url', () => {
  it.each([[[]], [[0]], [[1, 2]], [[1, 2, 3]], [[0xfb, 0xff, 0xbf, 0]], [[255, 254, 253, 252, 251]]])('round-trips the bytes %j', (values) => {
    const raw = bytes(...values);

    expect(fromBase64(toBase64(raw))).toEqual(raw);
    expect(fromBase64Url(toBase64Url(raw))).toEqual(raw);
  });

  it('writes base64url with - and _ and no padding', () => {
    expect(toBase64(bytes(0xfb, 0xff, 0xbf))).toBe('+/+/');
    expect(toBase64Url(bytes(0xfb, 0xff, 0xbf))).toBe('-_-_');
    expect(toBase64(bytes(1))).toBe('AQ==');
    expect(toBase64Url(bytes(1))).toBe('AQ');
  });

  it('makes random bytes of the length asked for', () => {
    expect(randomBytes(SALT_BYTES)).toHaveLength(16);
    expect(randomBytes(16)).not.toEqual(randomBytes(16));
  });
});

describe('sealList and openList', () => {
  let rawDataKey: Bytes;

  beforeAll(async () => {
    rawDataKey = await makeRawDataKey();
  });

  it('makes a random 256-bit data key', async () => {
    expect(rawDataKey).toHaveLength(32);
    expect(await makeRawDataKey()).not.toEqual(rawDataKey);
  });

  it('seals the list with no name or email in the ciphertext, and opens it again', async () => {
    const sealed = await sealList(rawDataKey, people);

    expect(JSON.stringify(sealed)).not.toContain('Jane');
    expect(atob(sealed.ct)).not.toContain('Jane');
    expect(await openList(rawDataKey, sealed)).toEqual(people);
  });

  it('uses a new 96-bit IV on every seal', async () => {
    const first = await sealList(rawDataKey, people);
    const second = await sealList(rawDataKey, people);

    expect(fromBase64(first.iv)).toHaveLength(IV_BYTES);
    expect(IV_BYTES).toBe(12);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ct).not.toBe(first.ct);
  });

  it.each([
    ['a changed ciphertext', (s: Sealed): Sealed => ({ ...s, ct: tamper(s.ct) })],
    ['a changed IV', (s: Sealed): Sealed => ({ ...s, iv: tamper(s.iv) })],
  ])('refuses %s with WrongSecretError', async (_label, change) => {
    const sealed = await sealList(rawDataKey, people);

    await expect(openList(rawDataKey, change(sealed))).rejects.toThrow(WrongSecretError);
  });

  it('refuses another data key with WrongSecretError', async () => {
    const sealed = await sealList(rawDataKey, people);

    await expect(openList(await makeRawDataKey(), sealed)).rejects.toThrow(WrongSecretError);
  });
});

describe('password method', () => {
  let rawDataKey: Bytes;
  let method: PasswordMethod;

  beforeAll(async () => {
    rawDataKey = await makeRawDataKey();
    method = await makePasswordMethod(rawDataKey, PASSWORD, NOW);
  }, PBKDF2_TIMEOUT);

  it('stores a 16-byte salt, the 600,000 iterations and a wrapped key, and no password', () => {
    expect(method).toMatchObject({ type: 'password', iterations: 600_000, createdAt: NOW.toISOString() });
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(fromBase64(method.salt)).toHaveLength(16);
    expect(fromBase64(method.iv)).toHaveLength(IV_BYTES);
    expect(JSON.stringify(method)).not.toContain('tangerine');
    expect(fromBase64(method.wrapped)).not.toEqual(rawDataKey);
  });

  it(
    'opens with the right password, deriving with PBKDF2-SHA-256 at 600,000 iterations and the stored salt',
    async () => {
      const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey');

      expect(await openPasswordMethod(method, PASSWORD)).toEqual(rawDataKey);
      expect(deriveKey).toHaveBeenCalledTimes(1);
      const params = deriveKey.mock.calls[0]![0] as Pbkdf2Params;
      expect(params).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 });
      expect(new Uint8Array(params.salt as ArrayBuffer)).toEqual(fromBase64(method.salt));
    },
    PBKDF2_TIMEOUT,
  );

  it(
    'opens with the same password typed in decomposed (NFD) form',
    async () => {
      expect(await openPasswordMethod(method, PASSWORD.normalize('NFD'))).toEqual(rawDataKey);
    },
    PBKDF2_TIMEOUT,
  );

  it(
    'refuses a wrong password with WrongSecretError',
    async () => {
      await expect(openPasswordMethod(method, 'cafe-tangerine-owl')).rejects.toThrow(WrongSecretError);
    },
    PBKDF2_TIMEOUT,
  );

  it(
    'opens through openWithSecret with a password secret, passing over the other methods',
    async () => {
      const recovery = await makeRecoveryMethod(rawDataKey, CODE, NOW);

      expect(await openWithSecret([recovery, method], { type: 'password', password: PASSWORD })).toEqual({ rawDataKey, method });
    },
    PBKDF2_TIMEOUT,
  );
});

describe('passkey method', () => {
  it('wraps the data key under the PRF output and opens with the same output only', async () => {
    const rawDataKey = await makeRawDataKey();
    const prfOutput = randomBytes(32);
    const input = passkey('cross-platform', 'cred-1', prfOutput);

    const method = await makePasskeyMethod(rawDataKey, input, NOW);

    expect(method).toMatchObject({
      type: 'passkey',
      kind: 'cross-platform',
      name: 'cross-platform key',
      credentialId: 'cred-1',
      prfSalt: input.prfSalt,
      transports: ['usb'],
      createdAt: NOW.toISOString(),
      lastUsedAt: null,
    });
    expect(fromBase64(method.hkdfSalt)).toHaveLength(SALT_BYTES);
    expect(await openPasskeyMethod(method, prfOutput)).toEqual(rawDataKey);
    await expect(openPasskeyMethod(method, randomBytes(32))).rejects.toThrow(WrongSecretError);
  });

  it('gives two methods made from the same PRF output their own HKDF salt and id', async () => {
    const rawDataKey = await makeRawDataKey();
    const input = passkey('platform', 'cred-1', randomBytes(32));

    const first = await makePasskeyMethod(rawDataKey, input, NOW);
    const second = await makePasskeyMethod(rawDataKey, input, NOW);

    expect(second.hkdfSalt).not.toBe(first.hkdfSalt);
    expect(second.id).not.toBe(first.id);
  });
});

describe('recovery code', () => {
  it('makes 160 random bits as 32 Crockford base32 characters, with no I, L, O or U', () => {
    const code = makeRecoveryCode();

    expect(RECOVERY_BYTES).toBe(20);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(makeRecoveryCode()).not.toBe(code);
  });

  it('shows the code as 4 groups of 8 characters, each written XXXX-XXXX', () => {
    expect(recoveryCodeGroups(CODE)).toEqual(['ABCD-EFGH', '0123-4567', '89JK-MNPQ', 'RSTV-WXYZ']);
  });

  it.each([
    ['the code as shown', CODE],
    ['lower case', CODE.toLowerCase()],
    ['the groups with hyphens and spaces', ' ABCD-EFGH 0123-4567\t89JK-MNPQ\nRSTV-WXYZ '],
    ['O for 0 and I for 1', 'ABCDEFGHOI23456789JKMNPQRSTVWXYZ'],
    ['l for 1', 'ABCDEFGH0l23456789JKMNPQRSTVWXYZ'],
  ])('reads %s', (_label, input) => {
    expect(normaliseRecoveryCode(input)).toBe(CODE);
  });

  it.each([
    ['an empty text', ''],
    ['31 characters', CODE.slice(1)],
    ['33 characters', `${CODE}A`],
    ['a U, which Crockford base32 does not use', `U${CODE.slice(1)}`],
    ['a character outside base32', `*${CODE.slice(1)}`],
  ])('refuses %s', (_label, input) => {
    expect(normaliseRecoveryCode(input)).toBeNull();
  });

  it('reads back every code it makes', () => {
    const code = makeRecoveryCode();

    expect(normaliseRecoveryCode(recoveryCodeGroups(code).join(' ').toLowerCase())).toBe(code);
  });
});

describe('recovery method', () => {
  let rawDataKey: Bytes;
  let method: RecoveryMethod;

  beforeAll(async () => {
    rawDataKey = await makeRawDataKey();
    method = await makeRecoveryMethod(rawDataKey, CODE, NOW);
  });

  it('stores a 16-byte salt and a wrapped key, and not the code', () => {
    expect(method).toMatchObject({ type: 'recovery', createdAt: NOW.toISOString(), usedAt: null });
    expect(fromBase64(method.salt)).toHaveLength(SALT_BYTES);
    expect(JSON.stringify(method)).not.toContain(CODE);
  });

  it('opens with the code typed in lower case, in groups', async () => {
    expect(await openRecoveryMethod(method, recoveryCodeGroups(CODE).join(' ').toLowerCase())).toEqual(rawDataKey);
  });

  it.each([
    ['a code that differs in its last character', `${CODE.slice(0, 31)}0`],
    ['a code that differs in its first character', `0${CODE.slice(1)}`],
    ['a made-up code', makeRecoveryCode()],
    ['a text that is not a code', 'not a code'],
  ])('refuses %s with WrongSecretError', async (_label, input) => {
    await expect(openRecoveryMethod(method, input)).rejects.toThrow(WrongSecretError);
  });
});

describe('openWithSecret', () => {
  let rawDataKey: Bytes;
  let oldRecovery: RecoveryMethod;
  let newRecovery: RecoveryMethod;
  const prfA = randomBytes(32);
  const prfB = randomBytes(32);

  beforeAll(async () => {
    rawDataKey = await makeRawDataKey();
    oldRecovery = await makeRecoveryMethod(rawDataKey, makeRecoveryCode(), NOW);
    newRecovery = await makeRecoveryMethod(rawDataKey, CODE, NOW);
  });

  it('opens the passkey method whose credential id matches, passing over the other types and the other credentials', async () => {
    const keyA = await makePasskeyMethod(rawDataKey, passkey('cross-platform', 'cred-a', prfA), NOW);
    const keyB = await makePasskeyMethod(rawDataKey, passkey('cross-platform', 'cred-b', prfB), NOW);

    expect(await openWithSecret([newRecovery, keyA, keyB], { type: 'passkey', credentialId: 'cred-b', prfOutput: prfB })).toEqual({
      rawDataKey,
      method: keyB,
    });
  });

  it('tries the next method of the same type when one refuses the secret', async () => {
    expect(await openWithSecret([oldRecovery, newRecovery], { type: 'recovery', code: CODE })).toEqual({ rawDataKey, method: newRecovery });
  });

  it.each([
    ['a wrong recovery code', { type: 'recovery', code: makeRecoveryCode() }],
    ['a passkey with no matching credential id', { type: 'passkey', credentialId: 'cred-x', prfOutput: prfA }],
    ['a password when no password method is set', { type: 'password', password: PASSWORD }],
  ] as const)('refuses %s with WrongSecretError', async (_label, secret) => {
    const keyA = await makePasskeyMethod(rawDataKey, passkey('cross-platform', 'cred-a', prfA), NOW);

    await expect(openWithSecret([oldRecovery, newRecovery, keyA], secret)).rejects.toThrow(WrongSecretError);
  });

  it('refuses a passkey with the matching credential id and a wrong PRF output with WrongSecretError', async () => {
    const keyA = await makePasskeyMethod(rawDataKey, passkey('cross-platform', 'cred-a', prfA), NOW);

    await expect(openWithSecret([keyA], { type: 'passkey', credentialId: 'cred-a', prfOutput: prfB })).rejects.toThrow(WrongSecretError);
  });

  it('passes on an error that is not a wrong secret', async () => {
    const broken: RecoveryMethod = { ...newRecovery, salt: 'not base64!' };

    const result = openWithSecret([broken, newRecovery], { type: 'recovery', code: CODE });

    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toBeInstanceOf(WrongSecretError);
  });
});

describe('backup file', () => {
  let rawDataKey: Bytes;
  let recovery: RecoveryMethod;
  const securityKeyPrf = randomBytes(32);
  const helloPrf = randomBytes(32);
  let text: string;

  beforeAll(async () => {
    rawDataKey = await makeRawDataKey();
    recovery = await makeRecoveryMethod(rawDataKey, CODE, NOW);
    const hello = await makePasskeyMethod(rawDataKey, passkey('platform', 'hello', helloPrf), NOW);
    const securityKey = await makePasskeyMethod(rawDataKey, passkey('cross-platform', 'key', securityKeyPrf), NOW);
    text = await makeBackup(rawDataKey, [hello, recovery, securityKey], people, NOW);
  });

  it('writes the backup format with no name or email in plain text', () => {
    const backup = parseBackup(text);

    expect(text.endsWith('}\n')).toBe(true);
    expect(backup).toMatchObject({ format: 'zt-backup', version: 1, createdAt: NOW.toISOString() });
    expect(text).not.toContain('Jane');
    expect(text).not.toContain('jane@example.org');
  });

  it('holds no Windows Hello wrapped key, and keeps the recovery code and the security key', () => {
    expect(parseBackup(text).methods.map((m) => (m.type === 'passkey' ? `${m.type}:${m.kind}` : m.type))).toEqual(['recovery', 'passkey:cross-platform']);
  });

  it.each([
    ['the recovery code', { type: 'recovery', code: CODE.toLowerCase() }],
    ['the security key', { type: 'passkey', credentialId: 'key', prfOutput: securityKeyPrf }],
  ] as const)('opens with %s', async (_label, secret) => {
    expect(await openBackup(parseBackup(text), secret)).toEqual(people);
  });

  it.each([
    ['a wrong recovery code', { type: 'recovery', code: makeRecoveryCode() }],
    ['the Windows Hello key, which the backup does not hold', { type: 'passkey', credentialId: 'hello', prfOutput: helloPrf }],
  ] as const)('refuses %s with WrongSecretError', async (_label, secret) => {
    await expect(openBackup(parseBackup(text), secret)).rejects.toThrow(WrongSecretError);
  });

  it('seals the list again with a new IV for each backup', async () => {
    const second = await makeBackup(rawDataKey, [recovery], people, NOW);

    expect(parseBackup(second).data.iv).not.toBe(parseBackup(text).data.iv);
  });

  const valid = { format: 'zt-backup', version: 1, createdAt: NOW.toISOString(), data: { iv: 'a', ct: 'b' }, methods: [] };

  it('reads a valid backup object', () => {
    expect(parseBackup(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([
    ['text that is not JSON', 'username,name\n'],
    ['null', 'null'],
    ['a number', '5'],
    ['a string', '"zt-backup"'],
    ['an array', '[]'],
    ['another format', JSON.stringify({ ...valid, format: 'other' })],
    ['another version', JSON.stringify({ ...valid, version: 2 })],
    ['no data', JSON.stringify({ ...valid, data: undefined })],
    ['methods that are not a list', JSON.stringify({ ...valid, methods: {} })],
  ])('refuses %s with BackupFormatError', (_label, input) => {
    expect(() => parseBackup(input)).toThrow(BackupFormatError);
  });

  it('gives each error its name and message', () => {
    expect(new BackupFormatError()).toMatchObject({ name: 'BackupFormatError', message: 'This file is not a Zero Trust Translator backup.' });
    expect(new WrongSecretError()).toMatchObject({ name: 'WrongSecretError', message: 'The secret does not open this list.' });
  });
});
