/**
 * The walled Lambda's public key(s), pinned by origin. The
 * Translator wraps a send batch's AES key under one of these
 * (`send-crypto.ts`), so only the matching Lambda's private key can open
 * it: the Translator itself never holds a private key and never calls a
 * server.
 *
 * An environment's entry is added here once its walled Lambda
 * is deployed and publishes its real public key. A key is not invented
 * ahead of that: a pinned key with no Lambda holding its private half would
 * silently fail every send, which is worse than pinning none and refusing
 * with "unknown origin".
 *
 * The dev key is added on top for a dev build: `scripts/build.mjs --dev`
 * reads it from `ZT_WALLED_DEV_ORIGIN` / `ZT_WALLED_DEV_KEY_ID` /
 * `ZT_WALLED_DEV_PUBLIC_KEY`, set by
 * the web app's end-to-end tests, and bakes it
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

/**
 * The production and staging keys: the public half of walled Key 1
 * (`alias/walled-sms-batch`, RSA-4096) of each environment. Production has
 * no entry until its walled stack is deployed and publishes a key.
 */
const PINNED_KEYS_BY_HOST: Record<string, WalledKey> = {
  'rb-branch-staging.org.uk': {
    keyId: 'walled-sms-batch-staging',
    publicKeySpki:
      'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAyscBAlwOQAFgrgbtSBziXNnbmGt/fgHE6LyLPPDjbMADond1iFqXUbm/h0OCXe4a9dW+YUZEba+EW58rdPOhgUs9ykcNzwjGhStLXn+n7h40Nj7VypJAY4Dygd+vV5G3kSoBP8EN9Xjb3er/H+jEb262stIuWVaKTFGp/MqKmv+/tZ8RNixI9/BBYWFj174PyKM1EwfiFMYz8hiHda75ZbkzvBVjAcTDA5LWn9PgWLXlagsKogrsFBGG2lrBW/rXhBHGW8Kab2pBNZBDD3Q9hp9mgHZLSGxj6sd+QNMgkIMFhdeGyXldAe+hynCq4U9ujtvjXyECUGKKfGikZu4wqzWeTBbRoWvQv5ZI1zuMhSJN+bu/i2ZHYZNaE4cP4Li/bH356UCqtkFunionBBDNNzx/3rgUL9pNi+AfkkkPN7axRNQtiWpFKtdVeeEKwP5vJsT3i2/u/DQDYB2E16K6zNXeTPakNX6R2akxcpT21OC5uAphrjOs/NhmTTCVV05PzX+0+ZwtML62scjG7ziaqy+F12GdnmmmcfFoQN7tr4LkwzE67iEZXGXvmaQl4neJziXN7xhIlRyrSqedRDKPPYcXi72oB27K/bLbqyaaHKUfLjrZ3byvBVMW01E95NKNPnp8XUM3yXhM2kDVYLlbCf2AIOFj1QtyfZOV4grYSe8CAwEAAQ==',
  },
};

/**
 * The pinned key for one page origin, or undefined when that origin has none.
 * A production or staging key is keyed by host, and matches only an `https:`
 * origin on the default port, so the bundle holds no URL.
 */
export function walledKeyFor(origin: string): WalledKey | undefined {
  const dev = devKeys()[origin];
  if (dev) return dev;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.origin !== origin) return undefined;
  return Object.hasOwn(PINNED_KEYS_BY_HOST, url.hostname) ? PINNED_KEYS_BY_HOST[url.hostname] : undefined;
}
