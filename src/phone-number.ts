/**
 * UK mobile numbers for SMS. Mirrors the web
 * app's phone number rules line for line: the walled Lambda must see the same E.164 form the
 * main app stores, so one opt-out list key works for both. The two repos
 * cannot share TypeScript source, so this file is a copy, not an import.
 *
 * A number is stored and compared in E.164 form (`+447700900123`).
 */

/** Characters people type between the digits. Removed before the digits are read. */
const SEPARATORS = /[\s\-().]/g;

/**
 * The 10 national digits after `+44`: a 7, then 9 digits.
 *
 * 070 (personal numbers) and 076 (pagers) are not mobiles, with the one
 * exception of 07624 (Isle of Man mobiles), per the Ofcom numbering plan.
 */
const NATIONAL_MOBILE = /^7(?:[1-57-9]\d{8}|624\d{6})$/;

/**
 * `+44 (0)7700 900123` is a common way to write a UK number for people
 * abroad. The bracketed 0 is not dialled, so it is dropped after `44` only.
 */
function afterCountryCode(rest: string): string {
  return rest.startsWith('07') ? rest.slice(1) : rest;
}

/**
 * Returns the E.164 form of a UK mobile number, or null when the input is
 * not one.
 *
 * Accepts `07700 900123`, `07700900123`, `+44 7700 900123`, `+447700900123`,
 * `447700900123`, `00447700900123` and `+44 (0)7700 900123`, with spaces,
 * dashes, dots or brackets anywhere.
 */
export function normaliseUkMobile(input: string): string | null {
  const compact = input.replace(SEPARATORS, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  const digits = compact.startsWith('+') ? compact.slice(1) : compact;
  let national: string;
  if (compact.startsWith('+')) {
    if (!digits.startsWith('44')) return null;
    national = afterCountryCode(digits.slice(2));
  } else if (digits.startsWith('0044')) {
    national = afterCountryCode(digits.slice(4));
  } else if (digits.startsWith('44')) {
    national = afterCountryCode(digits.slice(2));
  } else if (digits.startsWith('0')) {
    national = digits.slice(1);
  } else {
    return null;
  }

  return NATIONAL_MOBILE.test(national) ? `+44${national}` : null;
}
