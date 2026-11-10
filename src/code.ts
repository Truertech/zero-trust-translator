/**
 * The per-person code (#3919): a short id the walled SMS Lambda sees in
 * place of the username, so the Lambda never learns which branch member a
 * send batch names. Mirrors `newZeroTrustRef` in
 * `paulmorrishill/RestoreMemberEngagement`'s `polls-api`
 * (`zero-trust-people.ts`), so the admin app's `PersonName.tsx` draws a code
 * with the same shield it draws a `ref-` reference with.
 */
import type { PersonRecord } from './types';
import { randomBytes } from './vault';

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A random code such as `ref-k3m9q2xa`. */
export function newCode(): string {
  const bytes = randomBytes(8);
  let out = 'ref-';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** The pattern `frontend/src/components/PersonName.tsx` draws with the shield. */
export function isRefCode(value: string): boolean {
  return /^ref-[a-z0-9]+$/.test(value);
}

/** Gives a code to every person with none yet. A person with a code keeps it. */
export function ensureCoded(people: PersonRecord[]): PersonRecord[] {
  return people.map((p) => (p.code ? p : { ...p, code: newCode() }));
}
