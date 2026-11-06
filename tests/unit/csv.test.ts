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
});
