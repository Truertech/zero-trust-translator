import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_USERNAME_MESSAGE,
  LEGACY_STORAGE_KEY,
  ListError,
  MISSING_EMAIL_MESSAGE,
  MISSING_USERNAME_MESSAGE,
  addPerson,
  peopleFromLegacy,
  removePerson,
  renameUser,
  searchPeople,
  sortPeople,
} from '../../src/store';
import { emailKey, emptyPerson, type PersonRecord, usernameKey } from '../../src/types';

function person(username: string, name = '', email = ''): PersonRecord {
  return { ...emptyPerson(username), name, email };
}

const jane = person('Macc1', 'Jane Example', 'jane@example.org');
const bob = person('macc2', 'Bob Sample', 'bob@example.org');

describe('types helpers', () => {
  it('compares usernames and emails trimmed and lower-case', () => {
    expect(usernameKey('  MaCC1 ')).toBe('macc1');
    expect(emailKey(' Jane@Example.ORG ')).toBe('jane@example.org');
  });

  it('makes an empty person with only the username set', () => {
    expect(emptyPerson('u1')).toEqual({
      username: 'u1',
      name: '',
      email: '',
      phone: '',
      address: '',
      postcode: '',
      kind: '',
      code: '',
      firstName: '',
      lastName: '',
    });
  });
});

describe('message constants', () => {
  it('keeps the words the popup shows', () => {
    expect(LEGACY_STORAGE_KEY).toBe('zt-people-v1');
    expect(DUPLICATE_USERNAME_MESSAGE).toBe('This username is already in your list');
    expect(MISSING_USERNAME_MESSAGE).toBe('Type a username or reference');
    expect(MISSING_EMAIL_MESSAGE).toBe('Type an email address');
  });

  it('makes a ListError with its name and message', () => {
    const error = new ListError('x');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ListError');
    expect(error.message).toBe('x');
  });
});

describe('sortPeople', () => {
  it('sorts by name, and by username for a person with no name, without changing the input', () => {
    const noName = person('anna');
    const input = [jane, noName, bob];

    expect(sortPeople(input).map((p) => p.username)).toEqual(['anna', 'macc2', 'Macc1']);
    expect(input).toEqual([jane, noName, bob]);
  });
});

describe('searchPeople', () => {
  it.each([
    ['part of a name, in any case', 'EXAMPLE', ['Macc1']],
    ['part of a username, in any case', 'MACC2', ['macc2']],
    ['a query with spaces round it', '  bob  ', ['macc2']],
    ['a query that matches nobody', 'zzz', []],
  ])('filters by %s', (_label, query, expected) => {
    expect(searchPeople([jane, bob], query).map((p) => p.username)).toEqual(expected);
  });

  it.each(['', '   '])('returns the whole list for the empty query %j', (query) => {
    const people = [jane, bob];

    expect(searchPeople(people, query)).toBe(people);
  });
});

describe('addPerson', () => {
  it('adds a trimmed username and email with every other field empty, without changing the input', () => {
    const input = [jane];

    expect(addPerson(input, '  macc3 ', ' new@example.org ')).toEqual([jane, person('macc3', '', 'new@example.org')]);
    expect(input).toEqual([jane]);
  });

  it.each([
    ['an empty username', '', 'a@example.org', MISSING_USERNAME_MESSAGE],
    ['a username of spaces', '   ', 'a@example.org', MISSING_USERNAME_MESSAGE],
    ['an empty email', 'macc3', '', MISSING_EMAIL_MESSAGE],
    ['an email with no @', 'macc3', 'example.org', MISSING_EMAIL_MESSAGE],
    ['a username already in the list, in another case', ' MACC1 ', 'a@example.org', DUPLICATE_USERNAME_MESSAGE],
  ])('refuses %s', (_label, username, email, message) => {
    expect(() => addPerson([jane], username, email)).toThrow(new ListError(message));
  });
});

describe('renameUser', () => {
  it('changes the username of the person found in any case, and keeps every other field', () => {
    expect(renameUser([jane, bob], 'MACC1', ' macc9 ')).toEqual([{ ...jane, username: 'macc9' }, bob]);
  });

  it('lets a person keep the same username with a new case', () => {
    expect(renameUser([jane, bob], 'Macc1', 'MACC1')).toEqual([{ ...jane, username: 'MACC1' }, bob]);
  });

  it('changes nothing when the old username is not in the list', () => {
    expect(renameUser([jane, bob], 'nobody', 'macc9')).toEqual([jane, bob]);
  });

  it.each([
    ['an empty username', '', MISSING_USERNAME_MESSAGE],
    ['a username of spaces', '  ', MISSING_USERNAME_MESSAGE],
    ['a username already in the list', 'Macc2', DUPLICATE_USERNAME_MESSAGE],
  ])('refuses %s', (_label, to, message) => {
    expect(() => renameUser([jane, bob], 'Macc1', to)).toThrow(new ListError(message));
  });
});

describe('removePerson', () => {
  it('removes the person given in any case and keeps the others', () => {
    expect(removePerson([jane, bob], ' MACC1 ')).toEqual([bob]);
  });

  it('changes nothing when the username is not in the list', () => {
    expect(removePerson([jane, bob], 'nobody')).toEqual([jane, bob]);
  });
});

describe('peopleFromLegacy', () => {
  it('reads the v0.1.0 map from id to name, and drops a value that is not a string', () => {
    expect(peopleFromLegacy({ macc1: 'Jane Example', macc2: 7, macc3: null })).toEqual([{ ...person('macc1', 'Jane Example'), firstName: 'Jane', lastName: 'Example' }]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a string', 'Jane'],
    ['a number', 5],
  ])('reads an empty list from %s', (_label, value) => {
    expect(peopleFromLegacy(value)).toEqual([]);
  });

  it('does not read a built-in object property name as a person', () => {
    expect(peopleFromLegacy({})).toEqual([]);
  });
});
