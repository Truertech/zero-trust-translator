/**
 * `encryptBatch`: the AES-256-GCM/RSA-OAEP-SHA-256 envelope around a
 * send batch. No background/vault code here, only the crypto: a fresh RSA
 * keypair stands in for the walled Lambda's pinned key, so the test can
 * decrypt what the real Lambda would decrypt with its own private half.
 */
import { describe, expect, it } from 'vitest';
import type { SendBatchPlaintext, SendRow } from '../../src/messages';
import { encryptBatch } from '../../src/send-crypto';
import { toBase64 } from '../../src/vault';

const ROWS: SendRow[] = [
  { code: 'ref-abc12345', phone: '+447700900123', firstName: 'Jane' },
  { code: 'ref-def67890', phone: '+447700900456', firstName: 'Bob' },
];

async function walledKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function publicKeyBase64(keyPair: CryptoKeyPair): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  return toBase64(new Uint8Array(spki));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** Decrypts a batch the same way the walled Lambda would, with its private key. */
async function decrypt(keyPair: CryptoKeyPair, batch: { wrappedKey: string; iv: string; ciphertext: string }): Promise<SendBatchPlaintext> {
  const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keyPair.privateKey, fromBase64(batch.wrappedKey));
  const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(batch.iv) }, aesKey, fromBase64(batch.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as SendBatchPlaintext;
}

describe('encryptBatch', () => {
  it('returns exactly wrappedKey, iv and ciphertext, nothing else', async () => {
    const keyPair = await walledKeyPair();
    const batch = await encryptBatch(ROWS, await publicKeyBase64(keyPair));
    expect(Object.keys(batch).sort()).toEqual(['ciphertext', 'iv', 'wrappedKey']);
  });

  it('decrypts, under the pinned public key, to the rows plus a one-time token and a recent timestamp', async () => {
    const keyPair = await walledKeyPair();
    const before = Date.now();
    const batch = await encryptBatch(ROWS, await publicKeyBase64(keyPair));
    const plaintext = await decrypt(keyPair, batch);

    expect(plaintext.rows).toEqual(ROWS);
    expect(plaintext.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(plaintext.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(plaintext.timestamp)).toBeLessThanOrEqual(Date.now());
  });

  it('cannot be decrypted under a different RSA key: only the matching private key opens it', async () => {
    const keyPair = await walledKeyPair();
    const otherKeyPair = await walledKeyPair();
    const batch = await encryptBatch(ROWS, await publicKeyBase64(keyPair));
    await expect(decrypt(otherKeyPair, batch)).rejects.toThrow();
  });

  it('encrypts an empty batch of rows', async () => {
    const keyPair = await walledKeyPair();
    const batch = await encryptBatch([], await publicKeyBase64(keyPair));
    const plaintext = await decrypt(keyPair, batch);
    expect(plaintext.rows).toEqual([]);
  });

  it('never repeats a token, an iv or a ciphertext across two calls with the same rows', async () => {
    const keyPair = await walledKeyPair();
    const publicKey = await publicKeyBase64(keyPair);
    const first = await encryptBatch(ROWS, publicKey);
    const second = await encryptBatch(ROWS, publicKey);

    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.wrappedKey).not.toEqual(second.wrappedKey);
    const [plaintextA, plaintextB] = await Promise.all([decrypt(keyPair, first), decrypt(keyPair, second)]);
    expect(plaintextA.token).not.toEqual(plaintextB.token);
  });
});
