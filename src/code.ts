/**
 * The per-person code: a short id the walled SMS Lambda sees in
 * place of the username, so the Lambda never learns which branch member a
 * send batch names. Uses the same shape as the web app's
 * `ref-` references, so the web app draws a code with the same shield it
 * draws a `ref-` reference with.
 */
import { emailKey, nationBuilderCode, nbIdOf, usernameKey, withSplitName, type PersonRecord } from './types';
import { randomBytes } from './vault';

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A random code such as `ref-k3m9q2xa`. */
export function newCode(): string {
  const bytes = randomBytes(8);
  let out = 'ref-';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** The pattern the web app draws with the shield. */
export function isRefCode(value: string): boolean {
  return /^ref-[a-z0-9]+$/.test(value);
}

/**
 * The email-to-code history: the code each email
 * last had, kept in the vault after the person is deleted, so that the
 * same person added again gets the same code back.
 */
export type CodeHistory = Record<string, string>;

/**
 * The code a person must have, or `''` when any code will do: a person with
 * a NationBuilder id has `ref-nb<id>`; else a `ref-` username (the wipe
 * reference) is the code.
 */
function requiredCode(person: PersonRecord): string {
  const nb = nationBuilderCode(nbIdOf(person));
  if (nb !== '') {
    return nb;
  }
  const key = usernameKey(person.username);
  return isRefCode(key) ? key : '';
}

/**
 * The code a person with no code gets, in this order: the NationBuilder
 * code (`ref-nb<id>`); else a `ref-` username (the wipe reference) is the
 * code; else the code the history holds for the email; else a new code.
 */
function firstCode(person: PersonRecord, history: CodeHistory): string {
  const nb = nationBuilderCode(nbIdOf(person));
  if (nb !== '') {
    return nb;
  }
  if (isRefCode(usernameKey(person.username))) {
    return usernameKey(person.username);
  }
  const email = emailKey(person.email);
  return (email !== '' ? history[email] : undefined) ?? newCode();
}

/** Writes the code of every person with an email into a copy of the history. */
function remember(people: PersonRecord[], history: CodeHistory): CodeHistory {
  const next = { ...history };
  for (const p of people) {
    const email = emailKey(p.email);
    if (email !== '' && p.code !== '') {
      next[email] = p.code;
    }
  }
  return next;
}

/** Gives a code to every person with none yet. A person with a code keeps it. */
export function ensureCoded(people: PersonRecord[], history: CodeHistory = {}): { people: PersonRecord[]; history: CodeHistory } {
  const coded = people.map(withSplitName).map((p) => (p.code ? p : { ...p, code: firstCode(p, history) }));
  return { people: coded, history: remember(coded, history) };
}

/**
 * The clean-up that runs before each SMS operation (`zt:listCodes`,
 * `zt:encryptForSend`). The NationBuilder id, then the username, is the
 * source of truth:
 * - a person with a NationBuilder id has `ref-nb<id>` as the code;
 * - else a person whose username is a `ref-` reference has that reference as the code;
 * - when two people hold the same code, the person who must have that code
 *   (by NationBuilder id or username) keeps it, else the first person in the
 *   list keeps it, and each other person gets a new code.
 * The clean-up changes codes only. It never removes a person and never
 * changes a phone number, so an opt-out (held by number in the walled
 * store) still applies to the person after a code change.
 */
export function resolveCodeConflicts(people: PersonRecord[], history: CodeHistory = {}): { people: PersonRecord[]; history: CodeHistory } {
  const fromUsername = people.map((p) => {
    const required = requiredCode(p);
    return required !== '' && p.code !== required ? { ...p, code: required } : p;
  });
  const owner = new Map<string, number>();
  const claims = (p: PersonRecord): boolean => requiredCode(p) === p.code;
  fromUsername.forEach((p, i) => {
    const current = owner.get(p.code);
    if (current === undefined || (claims(p) && !claims(fromUsername[current]!))) {
      owner.set(p.code, i);
    }
  });
  const taken = new Set(fromUsername.map((p) => p.code));
  const resolved = fromUsername.map((p, i) => {
    if (owner.get(p.code) === i) {
      return p;
    }
    let code = newCode();
    while (taken.has(code)) code = newCode();
    taken.add(code);
    return { ...p, code };
  });
  return { people: resolved, history: remember(resolved, history) };
}
