/** What a person is on the branch platform, as `people.csv` (#3785) writes it. Empty when the file did not say. */
export type PersonKind = 'user' | 'member' | 'respondent' | '';

/**
 * One row of the offline list. `username` keeps the case it was imported
 * with, for display; every comparison uses `usernameKey(username)`.
 * Every text field is `''` when the list does not hold a value.
 */
export interface PersonRecord {
  username: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  kind: PersonKind;
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
  return { username, name: '', email: '', phone: '', address: '', postcode: '', kind: '' };
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
