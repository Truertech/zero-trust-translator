import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/store';
import { installFakeChromeStorage } from './chrome-storage.fake';

beforeEach(() => {
  installFakeChromeStorage();
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
});
