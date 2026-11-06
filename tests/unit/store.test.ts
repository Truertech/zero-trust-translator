import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/store';
import { type FakeChromeStorage, installFakeChromeStorage } from './chrome-storage.fake';

let fake: FakeChromeStorage;

beforeEach(() => {
  fake = installFakeChromeStorage();
});

describe('store', () => {
  it('adds a new row', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    expect(await store.getAll()).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
  });

  it('replaces a row with the same id', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });
    await store.upsertOne({ id: 'macc1', name: 'Jane Changed' });

    expect(await store.getAll()).toEqual([{ id: 'macc1', name: 'Jane Changed' }]);
  });

  it('reports which of a set of candidate ids already exist, so the popup can ask before it replaces them', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    const existing = await store.findExistingIds([
      { id: 'macc1', name: 'ignored' },
      { id: 'macc2', name: 'ignored' },
    ]);

    expect(existing).toEqual(['macc1']);
  });

  it('deletes one row by id', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });
    await store.upsertOne({ id: 'macc2', name: 'John Doe' });

    await store.deleteOne('macc1');

    expect(await store.getAll()).toEqual([{ id: 'macc2', name: 'John Doe' }]);
  });

  it('deletes the whole list', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    await store.deleteAll();

    expect(await store.getAll()).toEqual([]);
  });

  it('keeps both rows when a second add starts before the first write finishes (double click)', async () => {
    const first = store.upsertOne({ id: 'macc1', name: 'Jane Example' });
    const second = store.upsertOne({ id: 'macc2', name: 'John Doe' });
    await Promise.all([first, second]);

    const people = await store.getAll();
    expect(people.map((p) => p.id).sort()).toEqual(['macc1', 'macc2']);
  });

  it('keeps an add that starts while a delete is still writing', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });
    await store.upsertOne({ id: 'macc2', name: 'John Doe' });

    const del = store.deleteOne('macc1');
    const add = store.upsertOne({ id: 'macc3', name: 'New Person' });
    await Promise.all([del, add]);

    const people = await store.getAll();
    expect(people.map((p) => p.id).sort()).toEqual(['macc2', 'macc3']);
  });

  it('searches by id or by name', () => {
    const people = [
      { id: 'macc1', name: 'Jane Example' },
      { id: 'macc2', name: 'John Doe' },
    ];

    expect(store.search(people, 'jane')).toEqual([people[0]]);
    expect(store.search(people, 'macc2')).toEqual([people[1]]);
    expect(store.search(people, '')).toEqual(people);
  });

  it('searches names case-insensitively and ignores spaces round the query', () => {
    const people = [
      { id: 'macc1', name: 'Jane Example' },
      { id: 'macc2', name: 'John Doe' },
    ];

    expect(store.search(people, '  JANE ')).toEqual([people[0]]);
    expect(store.search(people, '   ')).toEqual(people);
    expect(store.search(people, 'nobody')).toEqual([]);
  });

  it('lists people sorted by name', async () => {
    await store.upsertOne({ id: 'macc2', name: 'Zoe Last' });
    await store.upsertOne({ id: 'macc1', name: 'Adam First' });

    expect((await store.getAll()).map((p) => p.name)).toEqual(['Adam First', 'Zoe Last']);
  });

  it('reads an empty list when nothing has been stored yet', async () => {
    expect(await store.getAll()).toEqual([]);
    expect((await store.getAllAsMap()).size).toBe(0);
  });

  it('reads an empty list, and does not throw, when the stored value is not an object', async () => {
    fake.seed(store.STORAGE_KEY_FOR_TESTS, 'not an object');

    expect(await store.getAll()).toEqual([]);
  });

  it('reads the list as a map from id to name', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    expect([...(await store.getAllAsMap()).entries()]).toEqual([['macc1', 'Jane Example']]);
  });

  it('deletes a row when the id is given in a different case', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    await store.deleteOne('MACC1');

    expect(await store.getAll()).toEqual([]);
  });

  it('does not report a built-in object property name as an existing id', async () => {
    const existing = await store.findExistingIds([{ id: 'constructor', name: 'ignored' }]);

    expect(existing).toEqual([]);
  });

  it('adds every row of a many-row import in one call', async () => {
    await store.upsertMany([
      { id: 'macc1', name: 'Jane Example' },
      { id: 'macc2', name: 'John Doe' },
    ]);

    expect((await store.getAll()).map((p) => p.id).sort()).toEqual(['macc1', 'macc2']);
  });

  it('rejects a write the browser refused, and still runs the next write', async () => {
    fake.failNextSet(new Error('QUOTA_BYTES quota exceeded'));

    await expect(store.upsertOne({ id: 'macc1', name: 'Jane Example' })).rejects.toThrow('QUOTA_BYTES');
    await store.upsertOne({ id: 'macc2', name: 'John Doe' });

    expect(await store.getAll()).toEqual([{ id: 'macc2', name: 'John Doe' }]);
  });

  it('runs a delete-all clicked while an add is still writing after the add, so the list ends empty', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });

    const add = store.upsertOne({ id: 'macc2', name: 'John Doe' });
    const clear = store.deleteAll();
    await Promise.all([add, clear]);

    expect(await store.getAll()).toEqual([]);
  });

  it('keeps an add when a delete is clicked while the add is still writing', async () => {
    await store.upsertOne({ id: 'macc1', name: 'Jane Example' });
    await store.upsertOne({ id: 'macc2', name: 'John Doe' });

    const add = store.upsertOne({ id: 'macc3', name: 'New Person' });
    const del = store.deleteOne('macc1');
    await Promise.all([add, del]);

    expect((await store.getAll()).map((p) => p.id).sort()).toEqual(['macc2', 'macc3']);
  });

  it('reads the new list from a storage change record', () => {
    const map = store.mapFromChange({ newValue: { macc1: 'Jane Example' } });

    expect([...map.entries()]).toEqual([['macc1', 'Jane Example']]);
  });

  it('reads an empty list from a change record that removed the key, or from no record', () => {
    expect(store.mapFromChange({ oldValue: { macc1: 'Jane Example' } }).size).toBe(0);
    expect(store.mapFromChange(undefined).size).toBe(0);
  });
});
