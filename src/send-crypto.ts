/**
 * The send-batch encryption (#3919). WebCrypto only: no crypto package.
 *
 * On Allow, the plaintext batch holds a fresh 256-bit one-time token, the
 * current timestamp and the rows. A fresh random AES-256-GCM key encrypts
 * it, with a new random 96-bit IV. The AES key itself is wrapped with
 * RSA-OAEP-SHA-256 under the walled Lambda's pinned public key
 * (`walled-keys.ts`), so only that Lambda's private key can open it. The
 * Translator never holds that private key and never calls a server: this
 * module only encrypts, it never sends anything.
 */
import type { SendBatch, SendBatchPlaintext, SendRow } from './messages';
import { fromBase64, randomBytes, toBase64, type Bytes } from './vault';

function toHex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function importRsaPublicKey(spki: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
}

/** Encrypts the rows, a fresh token and the time under a fresh AES key, then wraps that key under `publicKeySpkiBase64`. */
export async function encryptBatch(rows: SendRow[], publicKeySpkiBase64: string): Promise<SendBatch> {
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = randomBytes(12);
  const plaintext: SendBatchPlaintext = { token: toHex(randomBytes(32)), timestamp: new Date().toISOString(), rows };
  const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, bytes));
  const rawAesKey = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));
  const rsaPublicKey = await importRsaPublicKey(fromBase64(publicKeySpkiBase64));
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaPublicKey, rawAesKey));
  return { wrappedKey: toBase64(wrappedKey), iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}
