import { describe, expect, it } from 'vitest';
import { parseCsvRows } from '../../src/csv';
import {
  FORMAT_LABELS,
  applyCsv,
  applyNationBuilder,
  changesFor,
  countMatches,
  detectCsvFormat,
  isBackupText,
  mergePeople,
  planNationBuilderImport,
  previewCsv,
  skippedRows,
  type NbMatch,
} from '../../src/import';
import { DETAIL_FIELDS, MissingIdColumnError, emptyPerson, type PersonRecord } from '../../src/types';

const MEMBER_HEADER = 'name,address,postcode,area,email,phone,joinDate';
const ALL_HEADER = 'id,name,email,phone,address1,address2,address3,city,postcode';

function person(username: string, fields: Partial<PersonRecord> = {}): PersonRecord {
  return { ...emptyPerson(username), ...fields };
}

const jane = person('Macc1', { name: 'Jane Example', email: 'jane@example.org', phone: '07700 900001' });
const bob = person('macc2', { name: 'Bob Sample', email: 'bob@example.org' });

describe('detectCsvFormat', () => {
  it.each([
    ['the member import layout', MEMBER_HEADER, 'nb-member'],
    ['the member import layout with spaces, any case and an extra column', 'Name, Address ,POSTCODE,area,Email,phone,Join Date,extra', 'nb-member'],
    ['the "All columns" layout', ALL_HEADER, 'nb-all'],
    ['the people.csv layout', 'username,kind,email,first name,last name,phone,address,postcode', 'people'],
    ['a username CSV with an email column', 'username,email', 'people'],
    ['a username CSV with a kind column', 'username,kind,name', 'people'],
    ['a plain username and name CSV', 'username,name', 'other'],
    ['a member layout with one column out of order', 'name,postcode,address,area,email,phone,joinDate', 'people'],
    ['an id,name header with no email third', 'id,name,phone', 'other'],
    ['an id,email,name header', 'id,email,name', 'people'],
    ['a name,email header with no id first', 'x,name,email', 'people'],
  ])('reads %s', (_label, header, format) => {
    expect(detectCsvFormat(header.split(','))).toBe(format);
  });

  it('gives each NationBuilder layout the label board 6 shows', () => {
    expect(FORMAT_LABELS['nb-member']).toBe('NationBuilder Export · member import format');
    expect(FORMAT_LABELS['nb-all']).toBe('NationBuilder Export · all columns');
  });
});

describe('isBackupText', () => {
  it.each([
    ['a JSON object', '{"format":"zt-backup"}', true],
    ['a JSON object after blank space', '\n  \t{}', true],
    ['a CSV', 'username,name\n', false],
    ['an empty text', '', false],
  ])('reads %s as %s', (_label, text, expected) => {
    expect(isBackupText(text)).toBe(expected);
  });
});

describe('mergePeople', () => {
  it('adds a new username, updates a changed one and counts an unchanged one, without changing the input', () => {
    const input = [jane, bob];
    const incoming = [person('macc3', { name: 'New Person' }), person('MACC1', { name: 'Jane A. Example' }), person('macc2', { name: 'Bob Sample' })];

    const result = mergePeople(input, incoming);

    expect(result).toEqual({
      people: [{ ...jane, name: 'Jane A. Example' }, bob, person('macc3', { name: 'New Person' })],
      added: 1,
      updated: 1,
      unchanged: 1,
    });
    expect(input).toEqual([jane, bob]);
  });

  it('keeps the value the list holds for every empty incoming cell', () => {
    const full = person('u1', { name: 'N', email: 'e@x.org', phone: 'p', address: 'a', postcode: 'pc', kind: 'member' });

    expect(mergePeople([full], [person('u1')])).toEqual({ people: [full], added: 0, updated: 0, unchanged: 1 });
  });

  it.each(['name', 'email', 'phone', 'address', 'postcode', 'kind'] as const)('replaces the %s with a new value', (field) => {
    const value = field === 'kind' ? 'user' : 'new value';

    const result = mergePeople([person('u1')], [person('u1', { [field]: value })]);

    expect(result.people[0]![field]).toBe(value);
    expect(result.updated).toBe(1);
  });

  it('updates a person the same file added in an earlier row', () => {
    const result = mergePeople([], [person('u1', { name: 'First' }), person('U1', { email: 'u1@example.org' })]);

    expect(result).toEqual({ people: [person('u1', { name: 'First', email: 'u1@example.org' })], added: 1, updated: 1, unchanged: 0 });
  });
});

describe('planNationBuilderImport', () => {
  it('matches the member import layout by email, ignoring case and spaces, and lists each changed field', () => {
    const rows = parseCsvRows(`${MEMBER_HEADER}\nJane A. Example,2 Low Road,AB1 2CD,North,  JANE@Example.ORG ,07700 900001,2020-01-01\n`);

    expect(planNationBuilderImport(rows, 'nb-member', [jane, bob])).toEqual({
      format: 'nb-member',
      rowCount: 1,
      matched: [
        {
          row: 2,
          username: 'Macc1',
          name: 'Jane Example',
          changes: [
            { field: 'name', from: 'Jane Example', to: 'Jane A. Example' },
            { field: 'address', from: '', to: '2 Low Road' },
            { field: 'postcode', from: '', to: 'AB1 2CD' },
          ],
        },
      ],
      notInList: [],
      noEmail: [],
      duplicate: [],
    });
  });

  it('joins the address lines of the "All columns" layout and drops the "Unknown" default', () => {
    const rows = parseCsvRows(`${ALL_HEADER}\n9,Jane Example,jane@example.org,,1 High St,,Unknown,Leeds,unknown\n`);

    expect(planNationBuilderImport(rows, 'nb-all', [jane]).matched[0]!.changes).toEqual([{ field: 'address', from: '', to: '1 High St, Leeds' }]);
  });

  it('does not let the email default for a missing name overwrite the name', () => {
    const rows = parseCsvRows(`${MEMBER_HEADER}\nJane@Example.org,Unknown,UNKNOWN,,jane@example.org,,\n`);

    expect(planNationBuilderImport(rows, 'nb-member', [jane]).matched).toEqual([{ row: 2, username: 'Macc1', name: 'Jane Example', changes: [] }]);
  });

  it('reads the cells past the end of a short row as empty', () => {
    const rows = parseCsvRows(`${ALL_HEADER}\n9,Jane B. Example,jane@example.org\n`);

    expect(planNationBuilderImport(rows, 'nb-all', [jane]).matched[0]!.changes).toEqual([{ field: 'name', from: 'Jane Example', to: 'Jane B. Example' }]);
  });

  it('reads a missing column and a short row as empty cells', () => {
    const rows = parseCsvRows('id,name,email\n9,Jane B. Example,jane@example.org\n');

    expect(planNationBuilderImport(rows, 'nb-all', [jane]).matched[0]!.changes).toEqual([{ field: 'name', from: 'Jane Example', to: 'Jane B. Example' }]);
  });

  it('sorts unmatched rows into "Email not in your list", "No email" and "Email twice in the file", and the counts add up to the row count', () => {
    const rows = parseCsvRows(
      [
        MEMBER_HEADER,
        'Jane Example,,,,jane@example.org,07700 900001,', // matched, up to date
        'No Email,,,,,,', // no email
        'Not An Email,,,,not-an-email,,', // no @
        'Stranger,,,,stranger@example.org,,', // not in list
        'Jane Twice,,,,JANE@example.org,,', // duplicate of a matched row
        'Stranger Twice,,,,stranger@example.org,,', // duplicate of an unmatched row
      ].join('\n'),
    );

    const plan = planNationBuilderImport(rows, 'nb-member', [jane, bob]);

    expect(plan.matched.map((m) => m.row)).toEqual([2]);
    expect(plan.noEmail).toEqual([
      { row: 3, reason: 'no email', label: 'No Email' },
      { row: 4, reason: 'no email', label: 'Not An Email' },
    ]);
    expect(plan.notInList).toEqual([{ row: 5, reason: 'not in list', label: 'stranger@example.org' }]);
    expect(plan.duplicate).toEqual([
      { row: 6, reason: 'duplicate', label: 'jane@example.org' },
      { row: 7, reason: 'duplicate', label: 'stranger@example.org' },
    ]);
    expect(plan.matched.length + plan.noEmail.length + plan.notInList.length + plan.duplicate.length).toBe(plan.rowCount);
    expect(plan.rowCount).toBe(6);
  });

  it('matches the first person when two people in the list share an email, and never matches a person with no email', () => {
    const first = person('first', { name: 'First', email: 'same@example.org' });
    const second = person('second', { name: 'Second', email: ' SAME@example.org' });
    const noEmail = person('noemail', { name: 'No Email' });
    const rows = parseCsvRows(`${MEMBER_HEADER}\nSomeone,,,,same@example.org,,\n`);

    expect(planNationBuilderImport(rows, 'nb-member', [noEmail, first, second]).matched[0]!.username).toBe('first');
  });
});

const match: NbMatch = {
  row: 2,
  username: 'Macc1',
  name: 'Jane Example',
  changes: [
    { field: 'name', from: 'Jane Example', to: 'Jane A. Example' },
    { field: 'phone', from: '07700 900001', to: '07700 900002' },
  ],
};

describe('changesFor', () => {
  it('keeps only the changes of the ticked fields', () => {
    expect(changesFor(match, ['phone', 'postcode'])).toEqual([match.changes[1]]);
    expect(changesFor(match, [])).toEqual([]);
  });
});

describe('countMatches and skippedRows', () => {
  const plan = {
    format: 'nb-member' as const,
    rowCount: 5,
    matched: [match, { ...match, row: 3, username: 'macc2', changes: [] }],
    notInList: [{ row: 6, reason: 'not in list' }],
    noEmail: [{ row: 4, reason: 'no email' }],
    duplicate: [{ row: 5, reason: 'duplicate' }],
  };

  it.each([
    [DETAIL_FIELDS, { changed: 1, upToDate: 1 }],
    [['address'] as const, { changed: 0, upToDate: 2 }],
  ])('splits the matched rows for the ticked fields %j', (fields, expected) => {
    expect(countMatches(plan, fields)).toEqual(expected);
  });

  it('lists every skipped row in file order', () => {
    expect(skippedRows(plan).map((s) => s.row)).toEqual([4, 5, 6]);
  });
});

describe('applyNationBuilder', () => {
  const plan = { format: 'nb-member' as const, rowCount: 1, matched: [match], notInList: [], noEmail: [], duplicate: [] };

  it('writes only the ticked fields and leaves the unticked ones unchanged, without changing the input', () => {
    const input = [jane, bob];

    expect(applyNationBuilder(input, plan, ['name'])).toEqual([{ ...jane, name: 'Jane A. Example' }, bob]);
    expect(input).toEqual([jane, bob]);
  });

  it('skips a match whose person was removed after the preview', () => {
    expect(applyNationBuilder([bob], plan, DETAIL_FIELDS)).toEqual([bob]);
  });
});

describe('previewCsv', () => {
  it.each([
    ['an empty file', ''],
    ['a file of blank lines', '\n\n'],
    ['a username-less CSV that is not NationBuilder', 'name,email\nJane,jane@example.org\n'],
  ])('refuses %s with MissingIdColumnError', (_label, text) => {
    expect(() => previewCsv(text, [jane])).toThrow(MissingIdColumnError);
  });

  it('plans a NationBuilder file against the list', () => {
    const preview = previewCsv(`${MEMBER_HEADER}\nJane A. Example,,,,jane@example.org,,\nX,,,,x@example.org,,\n`, [jane]);

    expect(preview).toMatchObject({ kind: 'nationbuilder', format: 'nb-member', label: FORMAT_LABELS['nb-member'], rowCount: 2 });
  });

  it('plans a NationBuilder "All columns" file against the list', () => {
    const preview = previewCsv(`${ALL_HEADER}
9,Jane A. Example,jane@example.org
`, [jane]);

    expect(preview).toMatchObject({ kind: 'nationbuilder', format: 'nb-all', label: FORMAT_LABELS['nb-all'], rowCount: 1 });
  });

  it.each([
    ['people.csv', 'username,email,name\nu1,u1@example.org,U One\n,,\n', 'people'],
    ['a username CSV', 'username,name\nu1,U One\n,\n', 'other'],
  ] as const)('reads %s as username-keyed rows', (_label, text, format) => {
    const preview = previewCsv(text, []);

    expect(preview).toMatchObject({ kind: 'people', format, label: FORMAT_LABELS[format], rowCount: 2 });
    expect(preview.kind === 'people' && preview.imported.map((p) => p.username)).toEqual(['u1']);
    expect(preview.kind === 'people' && preview.skipped).toEqual([{ row: 3, reason: 'no username', label: '' }]);
  });
});

describe('applyCsv', () => {
  it('applies a NationBuilder "All columns" file with the ticked fields', () => {
    const text = `${ALL_HEADER}
9,Jane A. Example,jane@example.org
`;

    expect(applyCsv(text, [jane, bob], ['name'])).toEqual({
      people: [{ ...jane, name: 'Jane A. Example' }, bob],
      result: { kind: 'nationbuilder', added: 0, updated: 1, unchanged: 0, skipped: [] },
    });
  });

  it('applies a NationBuilder file with the ticked fields and reports the counts and skipped rows', () => {
    const text = `${MEMBER_HEADER}\nJane A. Example,,,,jane@example.org,07700 900002,\nBob Sample,,,,bob@example.org,,\n,,,,,,\n`;

    expect(applyCsv(text, [jane, bob], ['name'])).toEqual({
      people: [{ ...jane, name: 'Jane A. Example' }, bob],
      result: { kind: 'nationbuilder', added: 0, updated: 1, unchanged: 1, skipped: [{ row: 4, reason: 'no email', label: '' }] },
    });
  });

  it('adds and replaces by username for a username-keyed file', () => {
    const text = 'username,name\nMACC1,Jane A. Example\nmacc3,New Person\nmacc2,Bob Sample\n,Nobody\n';

    expect(applyCsv(text, [jane, bob], DETAIL_FIELDS)).toEqual({
      people: [{ ...jane, name: 'Jane A. Example' }, bob, person('macc3', { name: 'New Person' })],
      result: { kind: 'people', added: 1, updated: 1, unchanged: 1, skipped: [{ row: 5, reason: 'no username', label: 'Nobody' }] },
    });
  });
});
