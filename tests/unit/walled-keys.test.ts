import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { walledKeyFor } from '../../src/walled-keys';

describe('walledKeyFor', () => {
  it('pins an RSA-4096 public key for the staging origin', () => {
    const key = walledKeyFor('https://rb-branch-staging.org.uk');

    expect(key?.keyId).toBe('walled-sms-batch-staging');
    const parsed = createPublicKey({ key: Buffer.from(key!.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
    expect(parsed.asymmetricKeyType).toBe('rsa');
    expect(parsed.asymmetricKeyDetails?.modulusLength).toBe(4096);
  });

  it.each(['https://rb-branch.org.uk', 'https://rb-branch-staging.org.uk.example.com', 'http://rb-branch-staging.org.uk', 'https://rb-branch-staging.org.uk:8443', 'https://rb-branch-staging.org.uk/', 'https://constructor', 'not an origin'])('pins no key for %s', (origin) => {
    expect(walledKeyFor(origin)).toBeUndefined();
  });
});
