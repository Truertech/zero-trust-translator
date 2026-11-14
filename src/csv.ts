/**
 * A small CSV reader, written in this repository (no CSV
 * package is approved). Handles double-quoted fields, embedded
 * commas and doubled quotes (`""` inside a quoted field means one `"`).
 * Both `\n` and `\r\n` line endings are accepted.
 */
import { MissingIdColumnError, splitName, type ParsedPeopleCsv, type PersonKind, type PersonRecord, type SkippedRow } from './types';

/** Splits CSV text into rows of raw string cells. Trailing blank lines are dropped. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Normalises a header cell the same way for every comparison: lower-case, no spaces. */
export function normaliseHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '');
}

const ID_HEADERS = ['username', 'reference', 'usernameorreference'];
const KINDS: readonly PersonKind[] = ['user', 'member', 'respondent'];

function readKind(raw: string): PersonKind {
  const kind = raw.trim().toLowerCase() as PersonKind;
  return KINDS.includes(kind) ? kind : '';
}

/** The index of the id column in a normalised header row, or -1. */
export function idColumnIndex(header: string[]): number {
  for (const name of ID_HEADERS) {
    const index = header.indexOf(name);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Reads the username-keyed formats: the `people.csv` wipe download
 * (`username, kind, email, first name, last name, phone, address,
 * postcode`), or any CSV with a `username`/`reference` column and a `name`
 * column, or `first name` and `last name`.
 *
 * A row needs a username, and a name or an email: a person with an email
 * and no name yet gets the name from the next NationBuilder import.
 *
 * Throws `MissingIdColumnError` when no column can serve as the id. The
 * popup shows that as one message and changes nothing in the list.
 */
export function parsePeopleCsv(text: string): ParsedPeopleCsv {
  return parsePeopleRows(parseCsvRows(text));
}

export function parsePeopleRows(rows: string[][]): ParsedPeopleCsv {
  if (rows.length === 0) {
    throw new MissingIdColumnError();
  }
  const header = rows[0]!.map(normaliseHeader);
  const idIndex = idColumnIndex(header);
  if (idIndex < 0) {
    throw new MissingIdColumnError();
  }
  const column = (cells: string[], name: string): string => {
    const index = header.indexOf(name);
    return index >= 0 ? (cells[index] ?? '').trim() : '';
  };
  const imported: PersonRecord[] = [];
  const skipped: SkippedRow[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const rowNumber = r + 1; // 1-based, header counted as row 1
    const username = (cells[idIndex] ?? '').trim();
    const firstNameCell = column(cells, 'firstname');
    const lastNameCell = column(cells, 'lastname');
    const name = column(cells, 'name') || [firstNameCell, lastNameCell].filter((part) => part.length > 0).join(' ');
    const { firstName, lastName } = firstNameCell || lastNameCell ? { firstName: firstNameCell, lastName: lastNameCell } : splitName(name);
    const email = column(cells, 'email');
    if (username.length === 0) {
      skipped.push({ row: rowNumber, reason: 'no username', label: name || email });
      continue;
    }
    if (name.length === 0 && email.length === 0) {
      skipped.push({ row: rowNumber, reason: 'no name or email', label: username });
      continue;
    }
    imported.push({
      username,
      name,
      email,
      phone: column(cells, 'phone'),
      address: column(cells, 'address'),
      postcode: column(cells, 'postcode'),
      kind: readKind(column(cells, 'kind')),
      code: '',
      firstName,
      lastName,
      nbId: '',
    });
  }
  return { imported, skipped };
}
