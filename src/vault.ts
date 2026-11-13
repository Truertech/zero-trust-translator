/**
 * The encrypted list. WebCrypto only: no crypto package.
 *
 * One random 256-bit AES-GCM DATA KEY encrypts the whole list, with a new
 * random 96-bit IV on every write. The data key is never stored in the
 * clear: each unlock method keeps its own copy of it, encrypted (wrapped)
 * with AES-GCM under a KEY-ENCRYPTION KEY that only that method can make:
 *
 * - password: PBKDF2-SHA-256, 600,000 iterations, a 16-byte random salt.
 *   No password hash is kept. A wrong password is found by the failed
 *   unwrap (AES-GCM refuses to decrypt under the wrong key).
 * - passkey (Windows Hello or a security key): the 32-byte output of the
 *   WebAuthn `prf` extension, through HKDF-SHA-256. Each credential has its
 *   own PRF salt, so two keys never give the same output.
 * - recovery code: 160 random bits, shown as 32 Crockford base32
 *   characters, through HKDF-SHA-256.
 *
 * Every function here is pure: it reads and returns values, and the
 * service worker (`background.ts`) decides what is stored where.
 */
import type { PersonRecord } from './types';

/** Bytes on a plain ArrayBuffer, the type WebCrypto and WebAuthn take. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const PRF_SALT_BYTES = 32;
export const RECOVERY_BYTES = 20; // 160 bits
const DATA_KEY_BITS = 256;

const PASSKEY_INFO = 'zero-trust-translator passkey v1';
const RECOVERY_INFO = 'zero-trust-translator recovery v1';

/** Base64 text of an AES-GCM ciphertext and its IV. */
export interface Sealed {
  iv: string;
  ct: string;
}

/** The data key, encrypted under the key-encryption key of one method. */
export interface WrappedKey {
  iv: string;
  wrapped: string;
}

export interface PasswordMethod extends WrappedKey {
  id: string;
  type: 'password';
  salt: string;
  iterations: number;
  createdAt: string;
}

export type PasskeyKind = 'platform' | 'cross-platform';

export interface PasskeyMethod extends WrappedKey {
  id: string;
  type: 'passkey';
  /** `platform` is Windows Hello on this PC; `cross-platform` is a security key. */
  kind: PasskeyKind;
  name: string;
  /** Base64url, as WebAuthn writes credential ids. */
  credentialId: string;
  /** The salt given to the `prf` extension, base64. */
  prfSalt: string;
  /** The HKDF salt, base64. */
  hkdfSalt: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RecoveryMethod extends WrappedKey {
  id: string;
  type: 'recovery';
  salt: string;
  createdAt: string;
  usedAt: string | null;
}

export type UnlockMethod = PasswordMethod | PasskeyMethod | RecoveryMethod;

/** What `chrome.storage.local` holds under `zt-vault-v1`. Ciphertext, IVs, salts and wrapped keys only. */
export interface Vault {
  version: 1;
  createdAt: string;
  data: Sealed;
  /** The email-to-code history (`code.ts`), sealed under the data key. Absent until the first code is minted. */
  codeHistory?: Sealed;
  methods: UnlockMethod[];
}

/** The `.ztbackup` file. The same shape as the vault, with no Windows Hello method. */
export interface Backup {
  format: 'zt-backup';
  version: 1;
  createdAt: string;
  data: Sealed;
  methods: UnlockMethod[];
}

/** A secret that opens one method. */
export type Secret =
  | { type: 'password'; password: string }
  | { type: 'recovery'; code: string }
  | { type: 'passkey'; credentialId: string; prfOutput: Bytes };

/** The secret did not open the method: a wrong password, a wrong code, or a different key. */
export class WrongSecretError extends Error {
  constructor() {
    super('The secret does not open this list.');
    this.name = 'WrongSecretError';
  }
}

export class BackupFormatError extends Error {
  constructor() {
    super('This file is not a Zero Trust Translator backup.');
    this.name = 'BackupFormatError';
  }
}

// ---- bytes ----------------------------------------------------------------

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes: Bytes): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text);
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Base64url with no padding, the form WebAuthn uses for credential ids. */
export function toBase64Url(bytes: Bytes): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Bytes {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

function newId(): string {
  return toBase64Url(randomBytes(9));
}

// ---- the data key and the list ----------------------------------------------

/** Makes a new random data key and returns its raw 32 bytes. */
export async function makeRawDataKey(): Promise<Bytes> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: DATA_KEY_BITS }, true, ['encrypt', 'decrypt']);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, plain: Bytes): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function open(key: CryptoKey, iv: string, ct: string): Promise<Bytes> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ct)));
  } catch {
    throw new WrongSecretError();
  }
}

/** Encrypts the list under the data key, with a new IV. */
export async function sealList(rawDataKey: Bytes, people: PersonRecord[]): Promise<Sealed> {
  return seal(await importAesKey(rawDataKey), utf8(JSON.stringify(people)));
}

export async function openList(rawDataKey: Bytes, sealed: Sealed): Promise<PersonRecord[]> {
  const plain = await open(await importAesKey(rawDataKey), sealed.iv, sealed.ct);
  return JSON.parse(new TextDecoder().decode(plain)) as PersonRecord[];
}

/** Encrypts the email-to-code history under the data key, with a new IV. */
export async function sealCodeHistory(rawDataKey: Bytes, history: Record<string, string>): Promise<Sealed> {
  return seal(await importAesKey(rawDataKey), utf8(JSON.stringify(history)));
}

/** Opens the email-to-code history. A vault with none gives an empty history. */
export async function openCodeHistory(rawDataKey: Bytes, sealed: Sealed | undefined): Promise<Record<string, string>> {
  if (!sealed) {
    return {};
  }
  const plain = await open(await importAesKey(rawDataKey), sealed.iv, sealed.ct);
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

async function wrapDataKey(kek: CryptoKey, rawDataKey: Bytes): Promise<WrappedKey> {
  const { iv, ct } = await seal(kek, rawDataKey);
  return { iv, wrapped: ct };
}

function unwrapDataKey(kek: CryptoKey, wrapped: WrappedKey): Promise<Bytes> {
  return open(kek, wrapped.iv, wrapped.wrapped);
}

// ---- password -----------------------------------------------------------------

async function passwordKek(password: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  // NFC first, so the same password typed on two keyboards that compose an
  // accented letter differently still opens the list.
  const base = await crypto.subtle.importKey('raw', utf8(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function makePasswordMethod(rawDataKey: Bytes, password: string, now: Date): Promise<PasswordMethod> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await passwordKek(password, salt, PBKDF2_ITERATIONS);
  return {
    id: newId(),
    type: 'password',
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    createdAt: now.toISOString(),
    ...(await wrapDataKey(kek, rawDataKey)),
  };
}

export async function openPasswordMethod(method: PasswordMethod, password: string): Promise<Bytes> {
  const kek = await passwordKek(password, fromBase64(method.salt), method.iterations);
  return unwrapDataKey(kek, method);
}

// ---- HKDF methods: passkey and recovery code -------------------------------------

async function hkdfKek(secret: Bytes, salt: Bytes, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface NewPasskey {
  kind: PasskeyKind;
  name: string;
  credentialId: string;
  prfSalt: string;
  prfOutput: Bytes;
  transports: string[];
}

export async function makePasskeyMethod(rawDataKey: Bytes, passkey: NewPasskey, now: Date): Promise<PasskeyMethod> {
  const hkdfSalt = randomBytes(SALT_BYTES);
  const kek = await hkdfKek(passkey.prfOutput, hkdfSalt, PASSKEY_INFO);
  return {
    id: newId(),
    type: 'passkey',
    kind: passkey.kind,
    name: passkey.name,
    credentialId: passkey.credentialId,
    prfSalt: passkey.prfSalt,
    hkdfSalt: toBase64(hkdfSalt),
    transports: passkey.transports,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    ...(await wrapDataKey(kek, rawDataKey)),
  };
}

export async function openPasskeyMethod(method: PasskeyMethod, prfOutput: Bytes): Promise<Bytes> {
  const kek = await hkdfKek(prfOutput, fromBase64(method.hkdfSalt), PASSKEY_INFO);
  return unwrapDataKey(kek, method);
}

/** Crockford base32: no I, L, O or U, so a code read aloud or copied by hand has no look-alike letters. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 160 random bits as 32 Crockford base32 characters. */
export function makeRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The 4 groups of 8 characters the screen shows, each written `XXXX-XXXX`. */
export function recoveryCodeGroups(code: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += 8) {
    const group = code.slice(i, i + 8);
    groups.push(`${group.slice(0, 4)}-${group.slice(4)}`);
  }
  return groups;
}

/**
 * Reads a code as the admin typed or pasted it: any case, with or without
 * spaces and hyphens, and with the look-alike letters Crockford base32 maps
 * (O to 0, I and L to 1). Returns `null` when the result is not 32 valid
 * characters.
 */
export function normaliseRecoveryCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== 32) {
    return null;
  }
  for (const ch of code) {
    if (!CROCKFORD.includes(ch)) {
      return null;
    }
  }
  return code;
}

function decodeRecoveryCode(code: string): Bytes {
  const bytes = new Uint8Array(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of code) {
    value = ((value << 5) | CROCKFORD.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes[index] = (value >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }
  return bytes;
}

export async function makeRecoveryMethod(rawDataKey: Bytes, code: string, now: Date): Promise<RecoveryMethod> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await hkdfKek(decodeRecoveryCode(code), salt, RECOVERY_INFO);
  return {
    id: newId(),
    type: 'recovery',
    salt: toBase64(salt),
    createdAt: now.toISOString(),
    usedAt: null,
    ...(await wrapDataKey(kek, rawDataKey)),
  };
}

export async function openRecoveryMethod(method: RecoveryMethod, input: string): Promise<Bytes> {
  const code = normaliseRecoveryCode(input);
  if (code === null) {
    throw new WrongSecretError();
  }
  const kek = await hkdfKek(decodeRecoveryCode(code), fromBase64(method.salt), RECOVERY_INFO);
  return unwrapDataKey(kek, method);
}

// ---- opening a set of methods ----------------------------------------------------

/**
 * Finds the method the secret is for and returns the raw data key it holds,
 * with the method it opened. Throws `WrongSecretError` when no method of
 * that type opens with the secret.
 */
export async function openWithSecret(
  methods: UnlockMethod[],
  secret: Secret,
): Promise<{ rawDataKey: Bytes; method: UnlockMethod }> {
  for (const method of methods) {
    try {
      if (method.type === 'password' && secret.type === 'password') {
        return { rawDataKey: await openPasswordMethod(method, secret.password), method };
      }
      if (method.type === 'recovery' && secret.type === 'recovery') {
        return { rawDataKey: await openRecoveryMethod(method, secret.code), method };
      }
      if (method.type === 'passkey' && secret.type === 'passkey' && method.credentialId === secret.credentialId) {
        return { rawDataKey: await openPasskeyMethod(method, secret.prfOutput), method };
      }
    } catch (error) {
      if (!(error instanceof WrongSecretError)) {
        throw error;
      }
    }
  }
  throw new WrongSecretError();
}

// ---- backup file -------------------------------------------------------------------

/**
 * Writes the `.ztbackup` file: the list sealed again with a new IV, and
 * every method of the vault except Windows Hello. A Windows Hello key never
 * leaves the PC that made it, so a wrapped copy for it would open nothing
 * on another PC.
 */
export async function makeBackup(rawDataKey: Bytes, methods: UnlockMethod[], people: PersonRecord[], now: Date): Promise<string> {
  const backup: Backup = {
    format: 'zt-backup',
    version: 1,
    createdAt: now.toISOString(),
    data: await sealList(rawDataKey, people),
    methods: methods.filter((m) => !(m.type === 'passkey' && m.kind === 'platform')),
  };
  return JSON.stringify(backup, null, 2) + '\n';
}

export function parseBackup(text: string): Backup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupFormatError();
  }
  const backup = value as Partial<Backup> | null;
  if (
    !backup ||
    typeof backup !== 'object' ||
    backup.format !== 'zt-backup' ||
    backup.version !== 1 ||
    !backup.data ||
    !Array.isArray(backup.methods)
  ) {
    throw new BackupFormatError();
  }
  return backup as Backup;
}

/** Opens a backup with one secret and returns the list it holds. */
export async function openBackup(backup: Backup, secret: Secret): Promise<PersonRecord[]> {
  const { rawDataKey } = await openWithSecret(backup.methods, secret);
  return openList(rawDataKey, backup.data);
}
