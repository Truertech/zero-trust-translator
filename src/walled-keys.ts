/**
 * The walled Lambda's public key(s), pinned by origin (#3919, #3920). The
 * Translator wraps a send batch's AES key under one of these
 * (`send-crypto.ts`), so only the matching Lambda's private key can open
 * it: the Translator itself never holds a private key and never calls a
 * server.
 *
 * Production and staging entries are added here once #3920 deploys the
 * walled Lambda and publishes its real public key. A key is not invented
 * ahead of that: a pinned key with no Lambda holding its private half would
 * silently fail every send, which is worse than pinning none and refusing
 * with "unknown origin".
 *
 * The one entry here today is the dev key: `scripts/build.mjs --dev`
 * reads it from `ZT_WALLED_DEV_ORIGIN` / `ZT_WALLED_DEV_KEY_ID` /
 * `ZT_WALLED_DEV_PUBLIC_KEY`, set by
 * `zero-trust-extension.helper.ts` in `Truertech/RestoreMemberEngagement`
 * from `frontend/tests/e2e/fixtures/walled-sms-dev-key.json`, and bakes it
 * into the bundle as `__ZT_DEV_WALLED_KEY__`. `scripts/build.mjs` defines
 * that name only for a dev build with all three env vars set, so a release
 * build has no reference to it at all: `typeof __ZT_DEV_WALLED_KEY__` is
 * `'undefined'` there, the same as for any other undeclared global.
 */

export interface WalledKey {
  keyId: string;
  publicKeySpki: string;
}

declare const __ZT_DEV_WALLED_KEY__: string;

function devKeys(): Record<string, WalledKey> {
  if (typeof __ZT_DEV_WALLED_KEY__ === 'undefined') {
    return {};
  }
  const { origin, keyId, publicKeySpki } = JSON.parse(__ZT_DEV_WALLED_KEY__) as { origin: string; keyId: string; publicKeySpki: string };
  return { [origin]: { keyId, publicKeySpki } };
}

/** The production and staging keys. Empty until #3920 publishes a real one. */
const PINNED_KEYS: Record<string, WalledKey> = {};

/** The pinned key for one page origin, or undefined when that origin has none. */
export function walledKeyFor(origin: string): WalledKey | undefined {
  return { ...PINNED_KEYS, ...devKeys() }[origin];
}
