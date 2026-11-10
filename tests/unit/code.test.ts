/**
 * The code rules of #3919 (`code.ts`): which code a person gets first, the
 * email-to-code history, and the clean-up before an SMS operation.
 * `randomBytes` is replaced, so each new code is known before it is minted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPerson, type PersonRecord } from '../../src/types';

const fills: number[] = [];

vi.mock('../../src/vault', () => ({
  randomBytes: (n: number) => new Uint8Array(n).fill(fills.shift() ?? 0),
}));

const { ensureCoded, isRefCode, newCode, resolveCodeConflicts } = await import('../../src/code');

/** The code `newCode` mints when every random byte is `fill`: fill 0 gives `ref-aaaaaaaa`, fill 1 gives `ref-bbbbbbbb`. */
function codeOf(fill: number): string {
  return 'ref-' + 'abcdefghijkmnpqrstuvwxyz23456789'[fill]!.repeat(8);
}

function person(username: string, fields: Partial<PersonRecord> = {}): PersonRecord {
  return { ...emptyPerson(username), ...fields };
}

beforeEach(() => {
  fills.length = 0;
});

describe('newCode and isRefCode', () => {
  it('mints `ref-` and 8 characters that isRefCode accepts', () => {
    fills.push(1);
    expect(newCode()).toBe(codeOf(1));
    expect(isRefCode(codeOf(1))).toBe(true);
    expect(isRefCode('Macc1')).toBe(false);
  });
});

describe('ensureCoded', () => {
  it('keeps a code a person already has', () => {
    const { people } = ensureCoded([person('Macc1', { code: 'ref-kept1234' })]);
    expect(people[0]!.code).toBe('ref-kept1234');
  });

  it('uses a `ref-` username as the code, before the history and before a new code', () => {
    const { people } = ensureCoded([person('Ref-K3M9Q2XA', { email: 'jane@example.org' })], { 'jane@example.org': 'ref-oldcode1' });
    expect(people[0]!.code).toBe('ref-k3m9q2xa');
  });

  it('gives a person the code the history holds for the email, compared trimmed and lower-case', () => {
    const { people } = ensureCoded([person('Macc1', { email: ' Jane@Example.org ' })], { 'jane@example.org': 'ref-oldcode1' });
    expect(people[0]!.code).toBe('ref-oldcode1');
  });

  it('mints a new code when the history holds none for the email, or the person has no email', () => {
    fills.push(1, 2);
    const { people } = ensureCoded([person('Macc1', { email: 'new@example.org' }), person('Macc2')], { 'jane@example.org': 'ref-oldcode1' });
    expect(people.map((p) => p.code)).toEqual([codeOf(1), codeOf(2)]);
  });

  it('writes each email with its code into the history, keeps old entries, and skips a person with no email', () => {
    fills.push(1);
    const { history } = ensureCoded([person('Macc1', { email: 'Sam@Example.org' }), person('Macc2', { code: 'ref-noemail1' })], {
      'gone@example.org': 'ref-deleted1',
    });
    expect(history).toEqual({ 'gone@example.org': 'ref-deleted1', 'sam@example.org': codeOf(1) });
  });
});

describe('resolveCodeConflicts', () => {
  it('leaves a list with no conflict as it is', () => {
    const list = [person('Macc1', { code: 'ref-aaaa1111' }), person('Macc2', { code: 'ref-bbbb2222' })];
    expect(resolveCodeConflicts(list).people).toEqual(list);
  });

  it('takes the username as the source of truth: a `ref-` username replaces a different code', () => {
    const { people } = resolveCodeConflicts([person('ref-k3m9q2xa', { code: 'ref-other123' })]);
    expect(people[0]!.code).toBe('ref-k3m9q2xa');
  });

  it('when two people hold the same code and neither username is that code, the first keeps it and the second gets a new code', () => {
    fills.push(1);
    const { people } = resolveCodeConflicts([person('Macc1', { code: 'ref-same1234' }), person('Macc2', { code: 'ref-same1234' })]);
    expect(people.map((p) => p.code)).toEqual(['ref-same1234', codeOf(1)]);
  });

  it('the person whose username is the code keeps it, even when listed after the other', () => {
    fills.push(1);
    const { people } = resolveCodeConflicts([person('Macc1', { code: 'ref-k3m9q2xa' }), person('ref-k3m9q2xa', { code: 'ref-k3m9q2xa' })]);
    expect(people.map((p) => p.code)).toEqual([codeOf(1), 'ref-k3m9q2xa']);
  });

  it('the first claimant stays the owner when a later person with the same code does not claim it', () => {
    fills.push(1);
    const { people } = resolveCodeConflicts([person('ref-k3m9q2xa', { code: 'ref-k3m9q2xa' }), person('Macc2', { code: 'ref-k3m9q2xa' })]);
    expect(people.map((p) => p.code)).toEqual(['ref-k3m9q2xa', codeOf(1)]);
  });

  it('never gives a new code that another person already holds', () => {
    fills.push(1, 2);
    const { people } = resolveCodeConflicts([
      person('Macc1', { code: 'ref-same1234' }),
      person('Macc2', { code: 'ref-same1234' }),
      person('Macc3', { code: codeOf(1) }),
    ]);
    expect(people.map((p) => p.code)).toEqual(['ref-same1234', codeOf(2), codeOf(1)]);
  });

  it('keeps the phone and every other field, and writes the new code into the history', () => {
    fills.push(1);
    const second = person('Macc2', { code: 'ref-same1234', email: 'bob@example.org', phone: '07700 900456', name: 'Bob Stone' });
    const { people, history } = resolveCodeConflicts([person('Macc1', { code: 'ref-same1234' }), second], { 'bob@example.org': 'ref-same1234' });
    expect(people[1]).toEqual({ ...second, code: codeOf(1) });
    expect(history).toEqual({ 'bob@example.org': codeOf(1) });
  });
});
