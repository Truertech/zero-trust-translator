/**
 * The import preview and the update list (#3797).
 *
 * Two kinds of CSV come in:
 *
 * - USERNAME-KEYED: `people.csv` from the #3785 wipe download, or any CSV
 *   with a `username`/`reference` column (#3786). A row with a new username
 *   adds a person; a row with a username already in the list updates it.
 *   A cell with a value replaces what the list holds; an empty cell keeps it.
 * - NATIONBUILDER EXPORT (`tools/nationbuilder-export/` in
 *   `Truertech/RestoreMemberEngagement`): no username at all, so each row
 *   is matched to a person in the list by email, compared trimmed and
 *   lower-case. A matched row changes only the ticked fields.
 *
 * Every function here is pure, so the service worker can make the preview
 * and then make the same plan again when the admin confirms it.
 */
import { normaliseHeader, parseCsvRows, parsePeopleRows } from './csv';
import {
  DETAIL_FIELDS,
  MissingIdColumnError,
  emailKey,
  type DetailField,
  type PersonRecord,
  type SkippedRow,
  usernameKey,
} from './types';

export type CsvFormat = 'people' | 'other' | 'nb-member' | 'nb-all';

export const FORMAT_LABELS: Record<CsvFormat, string> = {
  people: 'people.csv · Zero Trust download',
  other: 'CSV with usernames',
  'nb-member': 'NationBuilder Export · member import format',
  'nb-all': 'NationBuilder Export · all columns',
};

/** The member import layout of the NationBuilder Export extension. */
const NB_MEMBER_HEADER = ['name', 'address', 'postcode', 'area', 'email', 'phone', 'joindate'];

/** Reads the layout from the header row alone. */
export function detectCsvFormat(headerCells: string[]): CsvFormat {
  const header = headerCells.map(normaliseHeader);
  if (NB_MEMBER_HEADER.every((name, i) => header[i] === name)) {
    return 'nb-member';
  }
  // "All columns" and the mailing layout both start `id,name,email`.
  if (header[0] === 'id' && header[1] === 'name' && header[2] === 'email') {
    return 'nb-all';
  }
  return header.includes('email') || header.includes('kind') ? 'people' : 'other';
}

/** Whether a file is an encrypted backup rather than a CSV. */
export function isBackupText(text: string): boolean {
  return text.trimStart().startsWith('{');
}

// ---- username-keyed import -------------------------------------------------------

export interface MergeCounts {
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * Adds and replaces by username. Returns the new list and the counts. A
 * value in `incoming` replaces the list's value; an empty value keeps it.
 */
export function mergePeople(current: PersonRecord[], incoming: PersonRecord[]): { people: PersonRecord[] } & MergeCounts {
  const people = current.map((p) => ({ ...p }));
  const byKey = new Map(people.map((p) => [usernameKey(p.username), p]));
  const counts: MergeCounts = { added: 0, updated: 0, unchanged: 0 };
  for (const person of incoming) {
    const existing = byKey.get(usernameKey(person.username));
    if (!existing) {
      const added = { ...person };
      people.push(added);
      byKey.set(usernameKey(person.username), added);
      counts.added += 1;
      continue;
    }
    let changed = false;
    for (const field of ['name', 'email', 'phone', 'address', 'postcode', 'kind'] as const) {
      const value = person[field];
      if (value !== '' && value !== existing[field]) {
        (existing as unknown as Record<string, string>)[field] = value;
        changed = true;
      }
    }
    if (changed) {
      counts.updated += 1;
    } else {
      counts.unchanged += 1;
    }
  }
  return { people, ...counts };
}

// ---- NationBuilder import ---------------------------------------------------------

export interface FieldChange {
  field: DetailField;
  from: string;
  to: string;
}

/** One row matched to a person, with every field whose value differs. */
export interface NbMatch {
  row: number;
  username: string;
  name: string;
  changes: FieldChange[];
}

export interface NbPlan {
  format: 'nb-member' | 'nb-all';
  rowCount: number;
  matched: NbMatch[];
  notInList: SkippedRow[];
  noEmail: SkippedRow[];
  duplicate: SkippedRow[];
}

/**
 * The exporter writes a default when NationBuilder holds no value: the
 * email for a missing name, and "Unknown" for a missing address or
 * postcode. Neither is a real value, so neither may overwrite one.
 */
function realValue(value: string, email: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'unknown' || emailKey(trimmed) === email) {
    return '';
  }
  return trimmed;
}

export function planNationBuilderImport(rows: string[][], format: 'nb-member' | 'nb-all', current: PersonRecord[]): NbPlan {
  const header = rows[0]!.map(normaliseHeader);
  const cell = (cells: string[], name: string): string => {
    const index = header.indexOf(name);
    return index >= 0 ? (cells[index] ?? '').trim() : '';
  };
  const byEmail = new Map<string, PersonRecord>();
  for (const person of current) {
    const key = emailKey(person.email);
    if (key !== '' && !byEmail.has(key)) {
      byEmail.set(key, person);
    }
  }
  const plan: NbPlan = { format, rowCount: rows.length - 1, matched: [], notInList: [], noEmail: [], duplicate: [] };
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const row = r + 1;
    const email = emailKey(cell(cells, 'email'));
    const rawName = cell(cells, 'name');
    if (!email.includes('@')) {
      plan.noEmail.push({ row, reason: 'no email', label: rawName });
      continue;
    }
    if (seen.has(email)) {
      plan.duplicate.push({ row, reason: 'duplicate', label: email });
      continue;
    }
    seen.add(email);
    const person = byEmail.get(email);
    if (!person) {
      plan.notInList.push({ row, reason: 'not in list', label: email });
      continue;
    }
    const address =
      format === 'nb-member'
        ? cell(cells, 'address')
        : ['address1', 'address2', 'address3', 'city']
            .map((name) => realValue(cell(cells, name), email))
            .filter((part) => part !== '')
            .join(', ');
    const incoming: Record<DetailField, string> = {
      name: realValue(rawName, email),
      phone: realValue(cell(cells, 'phone'), email),
      address: realValue(address, email),
      postcode: realValue(cell(cells, 'postcode'), email),
    };
    const changes: FieldChange[] = [];
    for (const field of DETAIL_FIELDS) {
      if (incoming[field] !== '' && incoming[field] !== person[field]) {
        changes.push({ field, from: person[field], to: incoming[field] });
      }
    }
    plan.matched.push({ row, username: person.username, name: person.name, changes });
  }
  return plan;
}

/** The changes of one match that the ticked fields allow. */
export function changesFor(match: NbMatch, fields: readonly DetailField[]): FieldChange[] {
  return match.changes.filter((change) => fields.includes(change.field));
}

/** The matched rows split into "Name or details change" and "Already up to date", for the ticked fields. */
export function countMatches(plan: NbPlan, fields: readonly DetailField[]): { changed: number; upToDate: number } {
  const changed = plan.matched.filter((m) => changesFor(m, fields).length > 0).length;
  return { changed, upToDate: plan.matched.length - changed };
}

/** Every skipped row of the plan, in file order. */
export function skippedRows(plan: NbPlan): SkippedRow[] {
  return [...plan.notInList, ...plan.noEmail, ...plan.duplicate].sort((a, b) => a.row - b.row);
}

export function applyNationBuilder(current: PersonRecord[], plan: NbPlan, fields: readonly DetailField[]): PersonRecord[] {
  const people = current.map((p) => ({ ...p }));
  const byKey = new Map(people.map((p) => [usernameKey(p.username), p]));
  for (const match of plan.matched) {
    const person = byKey.get(usernameKey(match.username));
    if (!person) {
      continue; // The person was removed after the preview: nothing to update.
    }
    for (const change of changesFor(match, fields)) {
      person[change.field] = change.to;
    }
  }
  return people;
}

// ---- one entry point for a CSV file ----------------------------------------------

export type CsvPreview =
  | { kind: 'nationbuilder'; format: 'nb-member' | 'nb-all'; label: string; rowCount: number; plan: NbPlan }
  | { kind: 'people'; format: 'people' | 'other'; label: string; rowCount: number; imported: PersonRecord[]; skipped: SkippedRow[] };

/** Reads a CSV file and plans its import against the current list. Writes nothing. */
export function previewCsv(text: string, current: PersonRecord[]): CsvPreview {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new MissingIdColumnError();
  }
  const format = detectCsvFormat(rows[0]!);
  if (format === 'nb-member' || format === 'nb-all') {
    const plan = planNationBuilderImport(rows, format, current);
    return { kind: 'nationbuilder', format, label: FORMAT_LABELS[format], rowCount: plan.rowCount, plan };
  }
  const parsed = parsePeopleRows(rows);
  return { kind: 'people', format, label: FORMAT_LABELS[format], rowCount: rows.length - 1, ...parsed };
}

/** What the import wrote, for board 8. */
export interface ImportResult {
  kind: 'nationbuilder' | 'people' | 'backup';
  added: number;
  updated: number;
  unchanged: number;
  skipped: SkippedRow[];
}

/** Plans the CSV again and applies it. */
export function applyCsv(text: string, current: PersonRecord[], fields: readonly DetailField[]): { people: PersonRecord[]; result: ImportResult } {
  const preview = previewCsv(text, current);
  if (preview.kind === 'nationbuilder') {
    const { changed, upToDate } = countMatches(preview.plan, fields);
    return {
      people: applyNationBuilder(current, preview.plan, fields),
      result: { kind: 'nationbuilder', added: 0, updated: changed, unchanged: upToDate, skipped: skippedRows(preview.plan) },
    };
  }
  const merged = mergePeople(current, preview.imported);
  return {
    people: merged.people,
    result: { kind: 'people', added: merged.added, updated: merged.updated, unchanged: merged.unchanged, skipped: preview.skipped },
  };
}
