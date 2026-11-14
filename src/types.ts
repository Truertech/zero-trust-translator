/** What a person is on the branch platform, as `people.csv` writes it. Empty when the file did not say. */
export type PersonKind = 'user' | 'member' | 'respondent' | '';

/**
 * One row of the offline list. `username` keeps the case it was imported
 * with, for display; every comparison uses `usernameKey(username)`.
 * Every text field is `''` when the list does not hold a value.
 *
 * `code` is the id the walled SMS Lambda sees in place of the username
 * (`code.ts`): every person gets one, minted once and kept for life.
 * `firstName` and `lastName` are the split of `name` a send batch needs; an
 * import that changes `name` re-splits them.
 * `nbId` is the person's NationBuilder member id, from a NationBuilder
 * Export import. A person with an `nbId` has the code `ref-nb<nbId>`
 * (`nationBuilderCode`), the same code on every admin's device, so the
 * RSVP link `#nb={{recipient.id}}` names the same code. A record saved
 * before this field existed has no `nbId` key: read it with `nbIdOf`.
 */
export interface PersonRecord {
  username: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  kind: PersonKind;
  code: string;
  firstName: string;
  lastName: string;
  nbId: string;
}

/** The fields an import can change. The username never changes by import. */
export type DetailField = 'name' | 'phone' | 'address' | 'postcode';

export const DETAIL_FIELDS: readonly DetailField[] = ['name', 'phone', 'address', 'postcode'];

/** The one way two usernames are compared: trimmed, lower-case. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/** The one way two emails are compared: trimmed, lower-case. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

export function emptyPerson(username: string): PersonRecord {
  return { username, name: '', email: '', phone: '', address: '', postcode: '', kind: '', code: '', firstName: '', lastName: '', nbId: '' };
}

/** The NationBuilder id of a person, or `''`. A record saved before `nbId` existed has no key. */
export function nbIdOf(person: PersonRecord): string {
  return typeof person.nbId === 'string' ? person.nbId.trim() : '';
}

/** A NationBuilder member id is a whole number. Anything else is not an id. */
export function isNationBuilderId(value: string): boolean {
  return /^[0-9]{1,18}$/.test(value.trim());
}

/** The code of a person with a NationBuilder id: `ref-nb` and the id, for example `ref-nb12345`. `''` for no valid id. */
export function nationBuilderCode(nbId: string): string {
  const id = nbId.trim();
  return isNationBuilderId(id) ? `ref-nb${id}` : '';
}

/** Splits a display name into a first and a last name, the way a send batch needs them. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const space = trimmed.indexOf(' ');
  if (space < 0) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space + 1).trim() };
}

/**
 * Gives a person with no first and no last name the split of `name`. A
 * record saved before codes existed has neither key, and a send batch needs the
 * first name. A person that has either name keeps both as they are.
 */
export function withSplitName(person: PersonRecord): PersonRecord {
  if (person.firstName || person.lastName) return person;
  return { ...person, ...splitName(person.name ?? '') };
}

/** One row the CSV reader skipped, and why. 1-based, counting the header as row 1. */
export interface SkippedRow {
  row: number;
  reason: string;
  /** The email or the name of the row, to show beside the row number. */
  label?: string;
}

export interface ParsedPeopleCsv {
  imported: PersonRecord[];
  skipped: SkippedRow[];
}

/** Thrown when the CSV has no column the reader can use as the id. */
export class MissingIdColumnError extends Error {
  constructor() {
    super('The file has no "username" or "reference" column.');
    this.name = 'MissingIdColumnError';
  }
}
