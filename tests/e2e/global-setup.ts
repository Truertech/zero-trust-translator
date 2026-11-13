// Builds the dev extension once before the Playwright run, into `dist-dev`
// (never `dist`/`dist.zip`, which are the release artifacts).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = Number(process.env['FIXTURE_PORT'] ?? '4321');

/** Where `translator.spec.ts` reads the dev walled key's private half back from, to decrypt a send batch. */
export const WALLED_DEV_KEY_PATH = join(ROOT, 'test-results', 'walled-dev-key.json');

/**
 * Mints a fresh RSA-OAEP keypair for this run only: the public half
 * is baked into the dev build as the pinned key for this fixture server's
 * origin, and the private half is written to `WALLED_DEV_KEY_PATH` so the
 * spec can decrypt a batch and prove the extension encrypted the right
 * thing. Never the production/staging key: those do not exist yet.
 */
async function makeWalledDevKey(): Promise<{ origin: string; keyId: string; publicKeySpki: string; privateKeyPkcs8: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  );
  const publicKeySpki = Buffer.from(await crypto.subtle.exportKey('spki', keyPair.publicKey)).toString('base64');
  const privateKeyPkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).toString('base64');
  return { origin: `http://localhost:${PORT}`, keyId: 'e2e-dev', publicKeySpki, privateKeyPkcs8 };
}

export default async function globalSetup(): Promise<void> {
  const walledKey = await makeWalledDevKey();
  mkdirSync(dirname(WALLED_DEV_KEY_PATH), { recursive: true });
  writeFileSync(WALLED_DEV_KEY_PATH, JSON.stringify(walledKey));

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      OUT_DIR: 'dist-dev',
      ZT_WALLED_DEV_ORIGIN: walledKey.origin,
      ZT_WALLED_DEV_KEY_ID: walledKey.keyId,
      ZT_WALLED_DEV_PUBLIC_KEY: walledKey.publicKeySpki,
    },
  });
}
