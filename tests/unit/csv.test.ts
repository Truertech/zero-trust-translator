import { describe, expect, it } from 'vitest';
import { parsePeopleCsv, writePeopleCsv } from '../../src/csv';
import { MissingIdColumnError } from '../../src/types';

describe('parsePeopleCsv', () => {
  it('imports every row with a name, from the #3785 wipe export columns', () => {
    const csv = [
      'username,kind,email,first name,last name,phone,address,postcode',
      'Macc1,real,,Jane,Example,,,',
      'Macc2,real,,John,Doe,,,',
    ].join('\n');

    const { imported, skipped } = parsePeopleCsv(csv);

    expect(imported).toEqual([
      { id: 'macc1', name: 'Jane Example' },
      { id: 'macc2', name: 'John Doe' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('accepts a "reference" id column and a combined "name" column', () => {
    const csv = ['reference,name', 'anon-7,Reference Only'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'anon-7', name: 'Reference Only' }]);
  });

  it('matches headers case-insensitively and ignoring spaces', () => {
    const csv = ['USERNAME, First Name , Last Name', 'Macc1,Jane,Example'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
  });

  it('lower-cases every imported id, so a marker matches case-insensitively', () => {
    const csv = ['username,name', 'MACC1,Jane Example'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported[0]?.id).toBe('macc1');
  });

  it('skips a row with an empty id, and reports why', () => {
    const csv = ['username,name', ',Jane Example'].join('\n');

    const { imported, skipped } = parsePeopleCsv(csv);

    expect(imported).toEqual([]);
    expect(skipped).toEqual([{ row: 2, reason: 'empty id' }]);
  });

  it('skips a row with an empty name, and reports why', () => {
    const csv = ['username,name', 'macc1,'].join('\n');

    const { imported, skipped } = parsePeopleCsv(csv);

    expect(imported).toEqual([]);
    expect(skipped).toEqual([{ row: 2, reason: 'empty name' }]);
  });

  it('refuses a CSV with no username or reference column', () => {
    expect(() => parsePeopleCsv(['name', 'Jane Example'].join('\n'))).toThrow(MissingIdColumnError);
  });

  it('refuses an empty file', () => {
    expect(() => parsePeopleCsv('')).toThrow(MissingIdColumnError);
  });

  it('handles a quoted field with an embedded comma', () => {
    const csv = ['username,name', '"macc1","Example, Jane"'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Example, Jane' }]);
  });

  it('reads a doubled quote inside a quoted field as one quote', () => {
    const csv = ['username,name', 'macc1,"Jane ""JJ"" Example"'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane "JJ" Example' }]);
  });

  it('accepts CRLF line endings and drops trailing blank lines', () => {
    const csv = 'username,name\r\nmacc1,Jane Example\r\n\r\n\r\n';

    const { imported, skipped } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
    expect(skipped).toEqual([]);
  });

  it('keeps a line break that sits inside a quoted field as part of the field', () => {
    const csv = ['username,name', 'macc1,"Jane', 'Example"'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane\nExample' }]);
  });

  it('reads the last row of a file that has no final line break', () => {
    const { imported } = parsePeopleCsv('username,name\nmacc1,Jane Example');

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
  });

  it('uses the username column when the file has both a username and a reference column', () => {
    const csv = ['reference,username,name', 'ref-1,macc1,Jane Example'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
  });

  it('prefers a "name" column over "first name" and "last name"', () => {
    const csv = ['username,first name,last name,name', 'macc1,Jane,Example,Preferred Name'].join('\n');

    const { imported } = parsePeopleCsv(csv);

    expect(imported).toEqual([{ id: 'macc1', name: 'Preferred Name' }]);
  });

  it('builds the name from "first name" alone or "last name" alone, with no stray space', () => {
    const firstOnly = parsePeopleCsv(['username,first name', 'macc1,Jane'].join('\n'));
    const lastOnly = parsePeopleCsv(['username,last name', 'macc2,Example'].join('\n'));

    expect(firstOnly.imported).toEqual([{ id: 'macc1', name: 'Jane' }]);
    expect(lastOnly.imported).toEqual([{ id: 'macc2', name: 'Example' }]);
  });

  it('skips every row as "empty name" when the file has no name column at all', () => {
    const { imported, skipped } = parsePeopleCsv(['username,email', 'macc1,a@example.org'].join('\n'));

    expect(imported).toEqual([]);
    expect(skipped).toEqual([{ row: 2, reason: 'empty name' }]);
  });

  it('reads a row shorter than the header as having empty cells', () => {
    const { skipped } = parsePeopleCsv(['name,username', 'Jane Example'].join('\n'));

    expect(skipped).toEqual([{ row: 2, reason: 'empty id' }]);
  });

  it('trims spaces round the id and the name', () => {
    const { imported } = parsePeopleCsv(['username,name', '  Macc1 ,  Jane Example  '].join('\n'));

    expect(imported).toEqual([{ id: 'macc1', name: 'Jane Example' }]);
  });

  it('refuses a file of blank lines only', () => {
    expect(() => parsePeopleCsv('\n\n\r\n')).toThrow(MissingIdColumnError);
  });
});

describe('writePeopleCsv', () => {
  it('writes a header and one row per person', () => {
    const csv = writePeopleCsv([{ id: 'macc1', name: 'Jane Example' }]);

    expect(csv).toBe('username,name\r\nmacc1,Jane Example\r\n');
  });

  it('quotes a name that contains a comma', () => {
    const csv = writePeopleCsv([{ id: 'macc1', name: 'Example, Jane' }]);

    expect(csv).toBe('username,name\r\nmacc1,"Example, Jane"\r\n');
  });

  it('quotes a value with a double quote and doubles the quote', () => {
    const csv = writePeopleCsv([{ id: 'macc1', name: 'Jane "JJ" Example' }]);

    expect(csv).toBe('username,name\r\nmacc1,"Jane ""JJ"" Example"\r\n');
  });

  it('quotes a value with a line break', () => {
    expect(writePeopleCsv([{ id: 'macc1', name: 'Jane\nExample' }])).toBe('username,name\r\nmacc1,"Jane\nExample"\r\n');
    expect(writePeopleCsv([{ id: 'macc1', name: 'Jane\rExample' }])).toBe('username,name\r\nmacc1,"Jane\rExample"\r\n');
  });

  it('writes a file that parsePeopleCsv reads back to the same list', () => {
    const people = [
      { id: 'macc1', name: 'Example, Jane' },
      { id: 'macc2', name: 'John "JD" Doe' },
    ];

    expect(parsePeopleCsv(writePeopleCsv(people)).imported).toEqual(people);
  });
});
