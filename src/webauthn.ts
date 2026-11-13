/**
 * Passkey registration and assertion with the WebAuthn `prf` extension
 *. Runs in an extension page (the popup, the options page or the
 * unlock tab), never in the service worker: `navigator.credentials` is a
 * window API.
 *
 * The `prf` output is 32 bytes that only this credential, given this salt,
 * can make. The service worker turns it into a key-encryption key with
 * HKDF (`vault.ts`). A credential whose registration does not report
 * `prf.enabled: true` cannot make that output, so it is never saved.
 */
import { PRF_SALT_BYTES, fromBase64, fromBase64Url, randomBytes, toBase64, toBase64Url } from './vault';
import type { Bytes, PasskeyKind } from './vault';

export const NO_PRF_MESSAGE = 'This device cannot hold an encryption key. Use a security key or a password.';

/** The registration or the assertion gave no `prf` output. */
export class NoPrfError extends Error {
  constructor() {
    super(NO_PRF_MESSAGE);
    this.name = 'NoPrfError';
  }
}

export interface RegisteredPasskey {
  kind: PasskeyKind;
  credentialId: string;
  prfSalt: string;
  prfOutput: string; // base64, for the runtime message to the service worker
  transports: string[];
}

export interface AssertedPasskey {
  credentialId: string;
  prfOutput: string; // base64
}

interface PrfResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | ArrayBufferView };
}

function prfOf(credential: PublicKeyCredential): PrfResults | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Bytes {
  // A copy, so the bytes sit on a plain ArrayBuffer of their own.
  return value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

/** Whether this PC offers Windows Hello (a user-verifying platform authenticator). */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') {
    return false;
  }
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

/**
 * Makes a new passkey on Windows Hello (`platform`) or a security key
 * (`cross-platform`) and reads its `prf` output for a new random salt.
 * Throws `NoPrfError` when the authenticator cannot give one.
 */
export async function registerPasskey(kind: PasskeyKind): Promise<RegisteredPasskey> {
  const prfSalt = randomBytes(PRF_SALT_BYTES);
  const credential = (await navigator.credentials.create({
    publicKey: {
      // The relying party is the extension's own origin, so no website can
      // ask this credential for anything.
      rp: { name: 'Zero Trust Translator' },
      user: { id: randomBytes(16), name: 'Zero Trust Translator list', displayName: 'Zero Trust Translator list' },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: kind,
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      timeout: 120_000,
      attestation: 'none',
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new NoPrfError();
  }
  const prf = prfOf(credential);
  if (prf?.enabled !== true) {
    throw new NoPrfError();
  }
  const credentialId = toBase64Url(new Uint8Array(credential.rawId));
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
  const saltText = toBase64(prfSalt);
  // Some authenticators report `enabled` at registration but give the
  // output only on an assertion. Ask for it at once in that case.
  const first = prf.results?.first;
  const prfOutput = first ? toBase64(bytesOf(first)) : (await assertPasskey([{ credentialId, prfSalt: saltText }])).prfOutput;
  return { kind, credentialId, prfSalt: saltText, prfOutput, transports };
}

/**
 * Asks for any one of `passkeys` and returns the credential that answered
 * with its `prf` output. Each credential is asked with its own salt.
 */
export async function assertPasskey(passkeys: { credentialId: string; prfSalt: string }[]): Promise<AssertedPasskey> {
  const evalByCredential: Record<string, { first: Bytes }> = {};
  for (const passkey of passkeys) {
    evalByCredential[passkey.credentialId] = { first: fromBase64(passkey.prfSalt) };
  }
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: fromBase64Url(p.credentialId) })),
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = credential ? prfOf(credential)?.results?.first : undefined;
  if (!credential || !first) {
    throw new NoPrfError();
  }
  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), prfOutput: toBase64(bytesOf(first)) };
}
