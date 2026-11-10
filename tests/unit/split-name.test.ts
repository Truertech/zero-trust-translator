/**
 * The first-name and last-name split of #3919 (`types.ts`): an import with no
 * first and last name columns, and a person saved before the split, take the
 * text before the first space as the first name.
 */
import { describe, expect, it } from 'vitest';
import { emptyPerson, splitName, withSplitName } from '../../src/types';

describe('splitName', () => {
  it('takes the text before the first space as the first name, and the rest as the last name', () => {
    expect(splitName('Jane A. Example')).toEqual({ firstName: 'Jane', lastName: 'A. Example' });
  });

  it('gives a name with no space as the first name only', () => {
    expect(splitName('Jane')).toEqual({ firstName: 'Jane', lastName: '' });
  });

  it('trims the name, and the spaces between the two parts', () => {
    expect(splitName('  Jane    Example  ')).toEqual({ firstName: 'Jane', lastName: 'Example' });
  });

  it('gives two empty parts for an empty name', () => {
    expect(splitName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('withSplitName', () => {
  it('splits `name` for a person with no first and no last name', () => {
    expect(withSplitName({ ...emptyPerson('u1'), name: 'Jane Example' })).toMatchObject({ firstName: 'Jane', lastName: 'Example' });
  });

  it('keeps a first name the person already has, and does not split `name` again', () => {
    const person = { ...emptyPerson('u1'), name: 'Jane Example', firstName: 'Janet' };
    expect(withSplitName(person)).toBe(person);
  });

  it('keeps a last name the person already has, and does not split `name` again', () => {
    const person = { ...emptyPerson('u1'), name: 'Jane Example', lastName: 'Smith' };
    expect(withSplitName(person)).toBe(person);
  });

  it('gives two empty parts to a stored person with no `name` at all', () => {
    const { name: _name, ...noName } = emptyPerson('u1');
    expect(withSplitName(noName as never)).toMatchObject({ firstName: '', lastName: '' });
  });
});
