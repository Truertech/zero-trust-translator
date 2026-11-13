/**
 * `normaliseUkMobile` decides which people go into a send batch and
 * which count as having a valid mobile in `zt:listCodes`. Each prefix form
 * and each refusal has its own case.
 */
import { describe, expect, it } from 'vitest';
import { normaliseUkMobile } from '../../src/phone-number';

describe('normaliseUkMobile', () => {
  it.each([
    ['07700 900123', 'national form with a space'],
    ['07700900123', 'national form with no separator'],
    ['+44 7700 900123', '+44 with no trunk zero'],
    ['+44 07700 900123', '+44 followed by the trunk zero'],
    ['0044 7700 900123', '0044 with no trunk zero'],
    ['0044 07700 900123', '0044 followed by the trunk zero'],
    ['447700900123', '44 with no plus'],
    ['4407700900123', '44 with no plus, followed by the trunk zero'],
    ['(07700) 900-123', 'brackets and a hyphen'],
    ['07700.900.123', 'dots'],
  ])('gives +447700900123 for %s (%s)', (input) => {
    expect(normaliseUkMobile(input)).toBe('+447700900123');
  });

  it('accepts the 07624 Isle of Man range, the one 076 range that is a mobile', () => {
    expect(normaliseUkMobile('07624 123456')).toBe('+447624123456');
  });

  it.each([
    ['', 'empty'],
    ['not a number', 'letters'],
    ['07700 9OO123', 'a letter O among the digits'],
    ['++447700900123', 'two plus signs'],
    ['447700+900123', 'a plus sign not at the start'],
    ['+33 7700 900123', 'a country code other than 44, with a national number that would pass'],
    ['7700900123', 'no prefix at all'],
    ['01632 960123', 'a landline'],
    ['07612 345678', 'a 076 pager number outside 07624'],
    ['07000 123456', 'a 070 personal number'],
    ['0770090012', 'one digit short'],
    ['077009001234', 'one digit long'],
  ])('refuses %j (%s)', (input) => {
    expect(normaliseUkMobile(input)).toBeNull();
  });
});
