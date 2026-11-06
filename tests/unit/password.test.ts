import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, STRENGTH_LABELS, checkPassword, isCommonPassword, passwordAccepted, passwordStrength } from '../../src/password';

describe('isCommonPassword', () => {
  it.each([
    ['a password in the bundled list', 'passwordpassword'],
    ['a listed password in another case with spaces round it', '  PasswordPassword '],
    ['one character typed over and over', 'aaaaaaaaaaaa'],
    ['one emoji typed over and over', '\u{1F600}'.repeat(12)],
    ['a forward run of the digit row', '345678901234'],
    ['a backward run of the digit row', '987654321098'],
  ])('finds %s', (_label, password) => {
    expect(isCommonPassword(password)).toBe(true);
  });

  it.each(['tangerine-owl-park', 'aaaaaaaaaaab', '135792468013'])('does not find %j', (password) => {
    expect(isCommonPassword(password)).toBe(false);
  });
});

describe('checkPassword', () => {
  it('needs at least 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(checkPassword('tangerine-o').longEnough).toBe(false);
    expect(checkPassword('tangerine-ow').longEnough).toBe(true);
  });

  it('counts characters, not UTF-16 code units, for the length', () => {
    expect(checkPassword('\u{1F600}'.repeat(11)).longEnough).toBe(false);
    expect(checkPassword('\u{1F600}'.repeat(12)).longEnough).toBe(true);
  });

  it.each([
    ['an empty password', '', false],
    ['a common password', 'password1234', false],
    ['a password not in the list', 'tangerine-ow', true],
  ])('sets notCommon for %s to %s', (_label, password, expected) => {
    expect(checkPassword(password).notCommon).toBe(expected);
  });
});

describe('passwordAccepted', () => {
  it.each([
    ['a long password not in the list', 'tangerine-owl', true],
    ['a short password', 'tangerine', false],
    ['a long common password', 'correcthorsebatterystaple', false],
    ['an empty password', '', false],
  ])('for %s is %s', (_label, password, expected) => {
    expect(passwordAccepted(password)).toBe(expected);
  });
});

describe('passwordStrength', () => {
  it.each([
    ['an empty field', '', 0],
    ['a short password', 'Tangerine1!', 1],
    ['a common password', 'Password1234!', 1],
    ['12 characters of two kinds', 'tangerine123', 2],
    ['12 characters of three kinds, with no symbol', 'Tangerine123', 3],
    ['12 characters of three kinds, with no capital', 'tangerine12!', 3],
    ['12 characters of three kinds, with no digit', 'Tangerine!ow', 3],
    ['12 characters of three kinds, with no small letter', 'TANGERINE12!', 3],
    ['15 characters of three kinds', 'Tangerineowl123', 3],
    ['16 characters of two kinds', 'tangerineowlp123', 3],
    ['19 characters of one kind', 'tangerineowlparkxyz', 3],
    ['16 characters of three kinds', 'Tangerineowlp123', 4],
    ['20 characters of one kind', 'tangerineowlparkxyzw', 4],
  ])('rates %s as %i', (_label, password, strength) => {
    expect(passwordStrength(password)).toBe(strength);
  });

  it('labels each strength for the bar', () => {
    expect(STRENGTH_LABELS).toEqual(['', 'Weak', 'Fair', 'Good', 'Strong']);
  });
});
