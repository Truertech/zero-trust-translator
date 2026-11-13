/**
 * The list operations (#3797). The list itself lives only inside the vault
 * (`vault.ts`): the service worker opens it with the data key, runs one of
 * these pure functions on it, and seals the result again. Nothing here
 * touches storage.
 */
import { emptyPerson, emailKey, splitName, type PersonRecord, usernameKey } from './types';

/** The v0.1.0 key: a plain `{ lower-case id: name }` object. Read once at setup, then removed. */
export const LEGACY_STORAGE_KEY = 'zt-people-v1';

export const DUPLICATE_USERNAME_MESSAGE = 'This username is already in your list';
export const MISSING_USERNAME_MESSAGE = 'Type a username or reference';
export const MISSING_EMAIL_MESSAGE = 'Type an email address';

/** A refused list change, with the message the popup shows. */
export class ListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListError';
  }
}

export function sortPeople(people: PersonRecord[]): PersonRecord[] {
  return [...people].sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));
}

/** Filters by name or username as the admin types. */
export function searchPeople(people: PersonRecord[], query: string): PersonRecord[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return people;
  }
  return people.filter((p) => usernameKey(p.username).includes(needle) || p.name.toLowerCase().includes(needle));
}

function hasUsername(people: PersonRecord[], username: string, except?: string): boolean {
  const key = usernameKey(username);
  return people.some((p) => usernameKey(p.username) === key && (except === undefined || usernameKey(p.username) !== usernameKey(except)));
}

/**
 * Adds a person with a username and an email. The name comes from the next
 * import. A code is not minted here: `people()` in `background.ts` mints
 * one for every code-less record on the next read, the same path a legacy
 * record goes through, so there is only one place that mints a code.
 */
export function addPerson(people: PersonRecord[], username: string, email: string): PersonRecord[] {
  const trimmed = username.trim();
  if (trimmed.length === 0) {
    throw new ListError(MISSING_USERNAME_MESSAGE);
  }
  if (!emailKey(email).includes('@')) {
    throw new ListError(MISSING_EMAIL_MESSAGE);
  }
  if (hasUsername(people, trimmed)) {
    throw new ListError(DUPLICATE_USERNAME_MESSAGE);
  }
  return [...people, { ...emptyPerson(trimmed), email: email.trim() }];
}

/** Changes the username of one person. The only edit the popup allows (board 4). */
export function renameUser(people: PersonRecord[], from: string, to: string): PersonRecord[] {
  const trimmed = to.trim();
  if (trimmed.length === 0) {
    throw new ListError(MISSING_USERNAME_MESSAGE);
  }
  if (hasUsername(people, trimmed, from)) {
    throw new ListError(DUPLICATE_USERNAME_MESSAGE);
  }
  return people.map((p) => (usernameKey(p.username) === usernameKey(from) ? { ...p, username: trimmed } : p));
}

export function removePerson(people: PersonRecord[], username: string): PersonRecord[] {
  return people.filter((p) => usernameKey(p.username) !== usernameKey(username));
}

/** Reads the v0.1.0 plain list. Anything that is not an object of strings gives an empty list. */
export function peopleFromLegacy(value: unknown): PersonRecord[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([id, name]) => ({ ...emptyPerson(id), name, ...splitName(name) }));
}
