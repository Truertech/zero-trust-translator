import { normaliseUkMobile } from './phone-number';

/**
 * A person's contact consent from NationBuilder: the six consent columns of
 * the NationBuilder Export member import format, read from the person's
 * NationBuilder edit page. Each flag is absent when the source did not say.
 *
 * The members platform applies the same rule to its own member rows
 * (`polls-api/src/application/use-cases/members/contact-consent.ts` in
 * Truertech/RestoreMemberEngagement). A missing flag allows the send: the
 * owner's decision of 2026-11-20.
 */
export interface ContactConsent {
  emailOptIn?: boolean;
  smsOptIn?: boolean;
  doNotContact?: boolean;
  doNotCall?: boolean;
  emailBad?: boolean;
  mobileBad?: boolean;
}

export const CONSENT_KEYS = ['emailOptIn', 'smsOptIn', 'doNotContact', 'doNotCall', 'emailBad', 'mobileBad'] as const;

/**
 * The consent of one CSV row. `header` holds the normalised (lower-case)
 * header names. A cell "true" or "false" sets the flag; any other value,
 * and a missing column, leaves it out. Returns null when the row sets none.
 */
export function consentFromCells(header: readonly string[], cells: readonly string[]): ContactConsent | null {
  const consent: ContactConsent = {};
  for (const key of CONSENT_KEYS) {
    const index = header.indexOf(key.toLowerCase());
    const value = index >= 0 ? (cells[index] ?? '').trim().toLowerCase() : '';
    if (value === 'true') consent[key] = true;
    if (value === 'false') consent[key] = false;
  }
  return Object.keys(consent).length === 0 ? null : consent;
}

/** True when consent bars a text: do not contact, not opted in to texts, or a bad mobile. */
export function smsBlockedByConsent(consent: ContactConsent | null | undefined): boolean {
  if (!consent) return false;
  return consent.doNotContact === true || consent.smsOptIn === false || consent.mobileBad === true;
}

/** The one rule for a text: a valid UK mobile, and consent that does not bar it. */
export function canText(person: { phone: string; consent?: ContactConsent | null }): boolean {
  return normaliseUkMobile(person.phone) !== null && !smsBlockedByConsent(person.consent);
}

/** True when two consents hold the same flags. */
export function sameConsent(a: ContactConsent | null | undefined, b: ContactConsent | null | undefined): boolean {
  return CONSENT_KEYS.every((key) => (a ?? {})[key] === (b ?? {})[key]);
}

/**
 * The consent as the import preview shows it: what the person allows, for
 * example "Texts: no · Emails: yes · Do not contact". Empty when nothing is known.
 */
export function consentLabel(consent: ContactConsent | null | undefined): string {
  if (!consent) return '';
  const yesNo = (value: boolean | undefined) => (value === undefined ? undefined : value ? 'yes' : 'no');
  return [
    yesNo(consent.smsOptIn) && `Texts: ${yesNo(consent.smsOptIn)}`,
    yesNo(consent.emailOptIn) && `Emails: ${yesNo(consent.emailOptIn)}`,
    consent.doNotContact === true && 'Do not contact',
    consent.doNotCall === true && 'Do not call',
    consent.emailBad === true && 'Bad email',
    consent.mobileBad === true && 'Bad mobile',
  ].filter((part): part is string => typeof part === 'string').join(' · ');
}
