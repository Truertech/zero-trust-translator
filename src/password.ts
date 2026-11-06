/**
 * The password rules of board 14 (#3797): at least 12 characters, and not
 * a common password. The strength bar is a guide for the admin only; the
 * two rules are what the service worker enforces.
 */
import { COMMON_PASSWORDS } from './common-passwords';

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordChecks {
  longEnough: boolean;
  notCommon: boolean;
}

export function isCommonPassword(password: string): boolean {
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return true;
  }
  // One character typed over and over, or a run of the digit row.
  if (/^(.)\1*$/u.test(lower) || '12345678901234567890'.includes(lower) || '09876543210987654321'.includes(lower)) {
    return true;
  }
  return false;
}

export function checkPassword(password: string): PasswordChecks {
  return {
    longEnough: [...password].length >= MIN_PASSWORD_LENGTH,
    notCommon: !isCommonPassword(password),
  };
}

export function passwordAccepted(password: string): boolean {
  const checks = checkPassword(password);
  return checks.longEnough && checks.notCommon;
}

export type Strength = 0 | 1 | 2 | 3 | 4;
export const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** 0 for an empty field, 1 (Weak) for a refused password, then 2 to 4 by length and character kinds. */
export function passwordStrength(password: string): Strength {
  if (password.length === 0) {
    return 0;
  }
  if (!passwordAccepted(password)) {
    return 1;
  }
  const length = [...password].length;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (length >= 20 || (length >= 16 && kinds >= 3)) {
    return 4;
  }
  if (length >= 16 || kinds >= 3) {
    return 3;
  }
  return 2;
}
