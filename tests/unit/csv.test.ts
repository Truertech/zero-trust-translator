import { describe, expect, it } from 'vitest';
import { idColumnIndex, normaliseHeader, parseCsvRows, parsePeopleCsv, parsePeopleRows } from '../../src/csv';
import { MissingIdColumnError } from '../../src/types';

const PEOPLE_HEADER = 'username,kind,email,first name,last name,phone,address,postcode';

describe('parseCsvRows', () => {
  it('splits plain rows and cells', () => {
    expect(parseCsvRows('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('reads a quoted field with an embedded comma as one cell', () => {
    expect(parseCsvRows('"Example, Jane",x')).toEqual([['Example, Jane', 'x']]);
  });

  it('reads a doubled quote inside a quoted field as one quote', () => {
    expect(parseCsvRows('"Jane ""JJ"" Example"')).toEqual([['Jane "JJ" Example']]);
  });

  it('keeps a line break that sits inside a quoted field as part of the field', () => {
    expect(parseCsvRows('"line one\nline two",b\n')).toEqual([['line one\nline two', 'b']]);
  });

  it('accepts CRLF line endings and drops trailing blank lines', () => {
    expect(parseCsvRows('a,b\r\nc,d\r\n\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops a blank line between two rows', () => {
    expect(parseCsvRows('a\n\nb')).toEqual([['a'], ['b']]);
  });

  it('reads the last row of a file that has no final line break', () => {
    expect(parseCsvRows('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps an empty last cell after a trailing comma, with and without a final line break', () => {
    expect(parseCsvRows('a,\n')).toEqual([['a', '']]);
    expect(parseCsvRows('a,')).toEqual([['a', '']]);
  });

  it('returns no rows for an empty text', () => {
    expect(parseCsvRows('')).toEqual([]);
  });
});

describe('normaliseHeader', () => {
  it.each([
    ['Username', 'username'],
    ['  First Name  ', 'firstname'],
    ['Username or\treference', 'usernameorreference'],
  ])('reads %j as %j', (cell, expected) => {
    expect(normaliseHeader(cell)).toBe(expected);
  });
});

describe('idColumnIndex', () => {
  it.each([
    [['name', 'username'], 1],
    [['reference', 'name'], 0],
    [['name', 'usernameorreference'], 1],
    [['reference', 'username'], 1],
    [['name', 'email'], -1],
  ])('finds the id column of %j at %i, preferring username over reference', (header, expected) => {
    expect(idColumnIndex(header)).toBe(expected);
  });
});

describe('parsePeopleCsv', () => {
  it('skips a row that ends before the username column, as a row with no username', () => {
    expect(parsePeopleCsv('name,username\nJane Example\n')).toEqual({ imported: [], skipped: [{ row: 2, reason: 'no username', label: 'Jane Example' }] });
  });

  it('imports every column of the people.csv wipe download', () => {
    const text = `${PEOPLE_HEADER}\nMacc1,member,jane@example.org,Jane,Example,07700 900000,1 High Street,AB1 2CD\n`;

    expect(parsePeopleCsv(text)).toEqual({
      imported: [
        {
          username: 'Macc1',
          kind: 'member',
          email: 'jane@example.org',
          name: 'Jane Example',
          phone: '07700 900000',
          address: '1 High Street',
          postcode: 'AB1 2CD',
          code: '',
          firstName: 'Jane',
          lastName: 'Example',
        },
      ],
      skipped: [],
    });
  });

  it('accepts a "reference" id column and a combined "name" column, with headers in any case and spacing', () => {
    const { imported } = parsePeopleCsv(' Reference , NAME \nR-7,Jane Example\n');

    expect(imported).toEqual([
      { username: 'R-7', name: 'Jane Example', email: '', phone: '', address: '', postcode: '', kind: '', code: '', firstName: 'Jane', lastName: 'Example' },
    ]);
  });

  it('keeps the case of the username as it was imported', () => {
    expect(parsePeopleCsv('username,name\nMaCC1,Jane\n').imported[0]!.username).toBe('MaCC1');
  });

  it('prefers a "name" column over "first name" and "last name"', () => {
    expect(parsePeopleCsv('username,name,first name,last name\nu1,Full Name,First,Last\n').imported[0]!.name).toBe('Full Name');
  });

  it.each([
    ['first name alone', 'u1,Jane,', 'Jane'],
    ['last name alone', 'u1,,Example', 'Example'],
  ])('builds the name from %s, with no stray space', (_label, row, expected) => {
    expect(parsePeopleCsv(`username,first name,last name\n${row}\n`).imported[0]!.name).toBe(expected);
  });

  it('imports a person with an email and no name, so the next NationBuilder import can add the name', () => {
    const { imported, skipped } = parsePeopleCsv('username,email\nu1,jane@example.org\n');

    expect(skipped).toEqual([]);
    expect(imported[0]).toMatchObject({ username: 'u1', name: '', email: 'jane@example.org' });
  });

  it.each([
    ['the name', 'username,name,email\n,Jane Example,jane@example.org\n', 'Jane Example'],
    ['the email when there is no name', 'username,name,email\n,,jane@example.org\n', 'jane@example.org'],
    ['nothing when there is no name and no email', 'username,name,email\n,,\n', ''],
  ])('skips a row with no username, labelled with %s', (_label, text, label) => {
    expect(parsePeopleCsv(text)).toEqual({ imported: [], skipped: [{ row: 2, reason: 'no username', label }] });
  });

  it('skips a row with no name and no email, labelled with the username', () => {
    expect(parsePeopleCsv('username,name,email\nu1,Jane,\nu2,,\n').skipped).toEqual([{ row: 3, reason: 'no name or email', label: 'u2' }]);
  });

  it('skips every row when the file has no name and no email column', () => {
    expect(parsePeopleCsv('username,phone\nu1,07700\n').skipped).toEqual([{ row: 2, reason: 'no name or email', label: 'u1' }]);
  });

  it.each([
    ['member', 'member'],
    ['USER', 'user'],
    [' Respondent ', 'respondent'],
    ['volunteer', ''],
    ['', ''],
  ])('reads the kind %j as %j', (raw, expected) => {
    expect(parsePeopleCsv(`username,name,kind\nu1,Jane,${raw}\n`).imported[0]!.kind).toBe(expected);
  });

  it('reads a row shorter than the header as having empty cells', () => {
    expect(parsePeopleCsv(`${PEOPLE_HEADER}\nu1,member,jane@example.org\n`).imported[0]).toEqual({
      username: 'u1',
      kind: 'member',
      email: 'jane@example.org',
      name: '',
      phone: '',
      address: '',
      postcode: '',
      code: '',
      firstName: '',
      lastName: '',
    });
  });

  it('trims spaces round every cell', () => {
    expect(parsePeopleCsv('username,name,email\n  u1  ,  Jane  ,  jane@example.org  \n').imported[0]).toMatchObject({
      username: 'u1',
      name: 'Jane',
      email: 'jane@example.org',
    });
  });

  it.each([
    ['an empty file', ''],
    ['a file of blank lines only', '\n\r\n\n'],
    ['a file with no username or reference column', 'name,email\nJane,jane@example.org\n'],
  ])('refuses %s with MissingIdColumnError', (_label, text) => {
    expect(() => parsePeopleCsv(text)).toThrow(MissingIdColumnError);
  });

  it('gives MissingIdColumnError the message the popup shows', () => {
    expect(() => parsePeopleRows([])).toThrow('The file has no "username" or "reference" column.');
  });

  it('keeps the first and last name columns as they are, and does not split the name column', () => {
    const { imported } = parsePeopleCsv('username,name,first name,last name\nu1,Jane A. Example,Jane A.,Example\n');
    expect(imported[0]).toMatchObject({ name: 'Jane A. Example', firstName: 'Jane A.', lastName: 'Example' });
  });

  it('takes a last name column with no first name column as the last name only', () => {
    const { imported } = parsePeopleCsv('username,last name\nu1,Example\n');
    expect(imported[0]).toMatchObject({ name: 'Example', firstName: '', lastName: 'Example' });
  });

  it('splits the name column when the first and last name cells are empty', () => {
    const { imported } = parsePeopleCsv('username,name,first name,last name\nu1,Jane Example,,\n');
    expect(imported[0]).toMatchObject({ firstName: 'Jane', lastName: 'Example' });
  });
});
