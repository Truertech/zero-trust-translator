/**
 * A small CSV reader and writer, written in this repository (issue #3786:
 * no CSV package is approved). Handles double-quoted fields, embedded
 * commas and doubled quotes (`""` inside a quoted field means one `"`).
 * Both `\n` and `\r\n` line endings are accepted.
 */
import { MissingIdColumnError, type ParsedPeopleCsv, type PersonRecord } from './types';

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
function normaliseHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Reads the extension's import format: the `people.csv` wipe export from
 * #3785, or any CSV with a `username`/`reference` column and a `name`
 * column, or both `first name` and `last name`.
 *
 * Throws `MissingIdColumnError` when no column can serve as the id — the
 * popup shows that as one message and changes nothing in the list.
 */
export function parsePeopleCsv(text: string): ParsedPeopleCsv {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new MissingIdColumnError();
  }
  const header = rows[0]!.map(normaliseHeader);
  const idIndex = header.indexOf('username') >= 0 ? header.indexOf('username') : header.indexOf('reference');
  if (idIndex < 0) {
    throw new MissingIdColumnError();
  }
  const nameIndex = header.indexOf('name');
  const firstNameIndex = header.indexOf('firstname');
  const lastNameIndex = header.indexOf('lastname');
  const imported: PersonRecord[] = [];
  const skipped: ParsedPeopleCsv['skipped'] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const rowNumber = r + 1; // 1-based, header counted as row 1
    const rawId = (cells[idIndex] ?? '').trim();
    let rawName = '';
    if (nameIndex >= 0) {
      rawName = (cells[nameIndex] ?? '').trim();
    } else if (firstNameIndex >= 0 || lastNameIndex >= 0) {
      const first = (cells[firstNameIndex] ?? '').trim();
      const last = (cells[lastNameIndex] ?? '').trim();
      rawName = [first, last].filter((part) => part.length > 0).join(' ');
    }
    if (rawId.length === 0) {
      skipped.push({ row: rowNumber, reason: 'empty id' });
      continue;
    }
    if (rawName.length === 0) {
      skipped.push({ row: rowNumber, reason: 'empty name' });
      continue;
    }
    imported.push({ id: rawId.toLowerCase(), name: rawName });
  }
  return { imported, skipped };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Writes the list back out in the same `username,name` shape the popup imports. */
export function writePeopleCsv(people: PersonRecord[]): string {
  const lines = ['username,name'];
  for (const person of people) {
    lines.push(`${csvEscape(person.id)},${csvEscape(person.name)}`);
  }
  return lines.join('\r\n') + '\r\n';
}
