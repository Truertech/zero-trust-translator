/**
 * The id-to-name list, kept in `chrome.storage.local` only (#3786: never
 * `chrome.storage.sync`, so the list never leaves this computer).
 */
import type { PersonRecord } from './types';

const STORAGE_KEY = 'zt-people-v1';

type StoredShape = Record<string, string>; // lower-case id -> name

async function readRaw(): Promise<StoredShape> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return value && typeof value === 'object' ? (value as StoredShape) : {};
}

async function writeRaw(shape: StoredShape): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: shape });
}

export async function getAll(): Promise<PersonRecord[]> {
  const raw = await readRaw();
  return Object.entries(raw)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The ids of `candidates` that already have a row in the list. */
export async function findExistingIds(candidates: PersonRecord[]): Promise<string[]> {
  const raw = await readRaw();
  return candidates.map((c) => c.id).filter((id) => Object.prototype.hasOwnProperty.call(raw, id));
}

/** Adds every row, replacing any row that shares its id. Callers ask the user before calling this when `findExistingIds` is non-empty. */
export async function upsertMany(people: PersonRecord[]): Promise<void> {
  const raw = await readRaw();
  for (const person of people) {
    raw[person.id] = person.name;
  }
  await writeRaw(raw);
}

export async function upsertOne(person: PersonRecord): Promise<void> {
  await upsertMany([person]);
}

export async function deleteOne(id: string): Promise<void> {
  const raw = await readRaw();
  delete raw[id.toLowerCase()];
  await writeRaw(raw);
}

export async function deleteAll(): Promise<void> {
  await writeRaw({});
}

export function search(people: PersonRecord[], query: string): PersonRecord[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return people;
  }
  return people.filter((p) => p.id.includes(needle) || p.name.toLowerCase().includes(needle));
}

/** Reads the current map straight from a `chrome.storage.onChanged` change record, with no extra read. */
export function mapFromChange(change: chrome.storage.StorageChange | undefined): Map<string, string> {
  const shape = (change?.newValue ?? {}) as StoredShape;
  return new Map(Object.entries(shape));
}

export async function getAllAsMap(): Promise<Map<string, string>> {
  const raw = await readRaw();
  return new Map(Object.entries(raw));
}

export const STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
