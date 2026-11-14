/**
 * The import preview and the update list.
 *
 * Two kinds of CSV come in:
 *
 * - USERNAME-KEYED: `people.csv` from the wipe download, or any CSV
 *   with a `username`/`reference` column. A row with a new username
 *   adds a person; a row with a username already in the list updates it.
 *   A cell with a value replaces what the list holds; an empty cell keeps it.
 * - NATIONBUILDER EXPORT: no username at all, so each row
 *   is matched to a person in the list by NationBuilder id, else by email,
 *   compared trimmed and lower-case. A matched row changes only the ticked
 *   fields, and always writes the row's NationBuilder id. A row that matches
 *   nobody adds a new person with the ticked fields; the username is the
 *   NationBuilder code `ref-nb<id>`, or a `ref-` code when the row has no
 *   id. The admin types the username later.
 *
 * Every function here is pure, so the service worker can make the preview
 * and then make the same plan again when the admin confirms it.
 */
import { newCode } from './code';
import { normaliseHeader, parseCsvRows, parsePeopleRows } from './csv';
import {
  DETAIL_FIELDS,
  MissingIdColumnError,
  emailKey,
  emptyPerson,
  isNationBuilderId,
  nationBuilderCode,
  nbIdOf,
  splitName,
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
    for (const field of ['name', 'email', 'phone', 'address', 'postcode', 'kind', 'firstName', 'lastName'] as const) {
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
  /** The row's NationBuilder id, or `''` when the row has none. */
  nbId: string;
  /** The person's NationBuilder id before the import, or `''`. */
  previousNbId: string;
}

/** One row that matches nobody in the list: a new person, with the row's values. */
export interface NbNew {
  row: number;
  email: string;
  values: Record<DetailField, string>;
  /** The row's NationBuilder id, or `''` when the row has none. */
  nbId: string;
}

/** Whether the import writes a new NationBuilder id on the matched person. Not a ticked field: it is always written. */
export function nbIdChanges(match: NbMatch): boolean {
  return match.nbId !== '' && match.nbId !== match.previousNbId;
}

export interface NbPlan {
  format: 'nb-member' | 'nb-all';
  rowCount: number;
  matched: NbMatch[];
  newPeople: NbNew[];
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
  // The member import layout holds the id in `nationbuilderId`; "All
  // columns" and the mailing layout hold it in `id`, the first column.
  const idColumn = format === 'nb-member' ? 'nationbuilderid' : 'id';
  const byEmail = new Map<string, PersonRecord>();
  const byNbId = new Map<string, PersonRecord>();
  for (const person of current) {
    const key = emailKey(person.email);
    if (key !== '' && !byEmail.has(key)) {
      byEmail.set(key, person);
    }
    const nbId = nbIdOf(person);
    if (nbId !== '' && !byNbId.has(nbId)) {
      byNbId.set(nbId, person);
    }
  }
  const plan: NbPlan = { format, rowCount: rows.length - 1, matched: [], newPeople: [], noEmail: [], duplicate: [] };
  const seen = new Set<string>();
  const seenNbIds = new Set<string>();
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const row = r + 1;
    const email = emailKey(cell(cells, 'email'));
    const rawName = cell(cells, 'name');
    const rawNbId = cell(cells, idColumn);
    const nbId = isNationBuilderId(rawNbId) ? rawNbId : '';
    if (!email.includes('@')) {
      plan.noEmail.push({ row, reason: 'no email', label: rawName });
      continue;
    }
    if (seen.has(email) || (nbId !== '' && seenNbIds.has(nbId))) {
      plan.duplicate.push({ row, reason: 'duplicate', label: email });
      continue;
    }
    seen.add(email);
    if (nbId !== '') {
      seenNbIds.add(nbId);
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
    const person = (nbId !== '' ? byNbId.get(nbId) : undefined) ?? byEmail.get(email);
    if (!person) {
      plan.newPeople.push({ row, email, values: incoming, nbId });
      continue;
    }
    const changes: FieldChange[] = [];
    for (const field of DETAIL_FIELDS) {
      if (incoming[field] !== '' && incoming[field] !== person[field]) {
        changes.push({ field, from: person[field], to: incoming[field] });
      }
    }
    plan.matched.push({ row, username: person.username, name: person.name, changes, nbId, previousNbId: nbIdOf(person) });
  }
  return plan;
}

/** The changes of one match that the ticked fields allow. */
export function changesFor(match: NbMatch, fields: readonly DetailField[]): FieldChange[] {
  return match.changes.filter((change) => fields.includes(change.field));
}

/** The matched rows split into "Name or details change" and "Already up to date", for the ticked fields. */
export function countMatches(plan: NbPlan, fields: readonly DetailField[]): { changed: number; upToDate: number } {
  const changed = plan.matched.filter((m) => changesFor(m, fields).length > 0 || nbIdChanges(m)).length;
  return { changed, upToDate: plan.matched.length - changed };
}

/** Every skipped row of the plan, in file order. */
export function skippedRows(plan: NbPlan): SkippedRow[] {
  return [...plan.noEmail, ...plan.duplicate].sort((a, b) => a.row - b.row);
}

/**
 * Applies the plan: the ticked fields of each matched person change, and
 * each new person is added with the ticked fields. Each row's NationBuilder
 * id is written whatever the ticked fields, and a person with an id gets the
 * code `ref-nb<id>` at once. A new person has no username yet, so the
 * username is the NationBuilder code, or a fresh `ref-` code (`mint`) for a
 * row with no id; `ensureCoded` also takes it as the person's code. A new
 * person whose email or id was added to the list after the preview is skipped.
 */
export function applyNationBuilder(current: PersonRecord[], plan: NbPlan, fields: readonly DetailField[], mint: () => string = newCode): PersonRecord[] {
  const people = current.map((p) => ({ ...p }));
  const byKey = new Map(people.map((p) => [usernameKey(p.username), p]));
  for (const match of plan.matched) {
    const person = byKey.get(usernameKey(match.username));
    if (!person) {
      continue; // The person was removed after the preview: nothing to update.
    }
    for (const change of changesFor(match, fields)) {
      person[change.field] = change.to;
      if (change.field === 'name') {
        Object.assign(person, splitName(change.to));
      }
    }
    if (match.nbId !== '') {
      person.nbId = match.nbId;
      person.code = nationBuilderCode(match.nbId);
    }
  }
  const emails = new Set(people.map((p) => emailKey(p.email)).filter((e) => e !== ''));
  const nbIds = new Set(people.map(nbIdOf).filter((id) => id !== ''));
  for (const entry of plan.newPeople) {
    if (emails.has(entry.email) || (entry.nbId !== '' && nbIds.has(entry.nbId))) {
      continue;
    }
    emails.add(entry.email);
    const nbCode = nationBuilderCode(entry.nbId);
    if (nbCode !== '') {
      nbIds.add(entry.nbId);
    }
    const added: PersonRecord = { ...emptyPerson(nbCode || mint()), email: entry.email, nbId: nbCode ? entry.nbId : '', code: nbCode };
    for (const field of fields) {
      added[field] = entry.values[field];
    }
    people.push({ ...added, ...splitName(added.name) });
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

/** What the import wrote, for the import result screen. */
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
      result: { kind: 'nationbuilder', added: preview.plan.newPeople.length, updated: changed, unchanged: upToDate, skipped: skippedRows(preview.plan) },
    };
  }
  const merged = mergePeople(current, preview.imported);
  return {
    people: merged.people,
    result: { kind: 'people', added: merged.added, updated: merged.updated, unchanged: merged.unchanged, skipped: preview.skipped },
  };
}
