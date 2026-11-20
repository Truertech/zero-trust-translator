import { describe, expect, it } from 'vitest';
import { canText, consentFromCells, consentLabel, sameConsent, smsBlockedByConsent } from '../../src/consent';

const HEADER = ['name', 'email', 'emailoptin', 'smsoptin', 'donotcontact', 'donotcall', 'emailbad', 'mobilebad'];

describe('consentFromCells', () => {
  it('reads true and false from the six lower-cased consent columns', () => {
    expect(consentFromCells(HEADER, ['Ann', 'a@x.org', 'true', 'FALSE', ' false ', 'true', 'false', 'false'])).toEqual({
      emailOptIn: true, smsOptIn: false, doNotContact: false, doNotCall: true, emailBad: false, mobileBad: false,
    });
  });

  it('leaves out an empty cell, another value, and a missing cell', () => {
    expect(consentFromCells(HEADER, ['Ann', 'a@x.org', '', 'yes', 'true'])).toEqual({ doNotContact: true });
  });

  it('returns null for a header with no consent column, and for a row that sets none', () => {
    expect(consentFromCells(['name', 'email'], ['Ann', 'a@x.org'])).toBeNull();
    expect(consentFromCells(HEADER, ['Ann', 'a@x.org', '', '', '', '', '', ''])).toBeNull();
  });
});

describe('smsBlockedByConsent', () => {
  it.each([
    [undefined, false],
    [null, false],
    [{}, false],
    [{ smsOptIn: true, doNotContact: false, mobileBad: false }, false],
    [{ emailOptIn: false, emailBad: true, doNotCall: true }, false],
    [{ doNotContact: true }, true],
    [{ smsOptIn: false }, true],
    [{ mobileBad: true }, true],
  ])('%j gives %s', (consent, expected) => {
    expect(smsBlockedByConsent(consent)).toBe(expected);
  });
});

describe('canText', () => {
  it('needs a UK mobile and consent that does not bar texts', () => {
    expect(canText({ phone: '07700 900123' })).toBe(true);
    expect(canText({ phone: '07700 900123', consent: { smsOptIn: true } })).toBe(true);
    expect(canText({ phone: '07700 900123', consent: { smsOptIn: false } })).toBe(false);
    expect(canText({ phone: '01227 700111' })).toBe(false);
    expect(canText({ phone: '' })).toBe(false);
  });
});

describe('sameConsent', () => {
  it('compares every flag, with null and absent the same as no flags', () => {
    expect(sameConsent({ smsOptIn: true }, { smsOptIn: true })).toBe(true);
    expect(sameConsent(null, undefined)).toBe(true);
    expect(sameConsent(null, {})).toBe(true);
    expect(sameConsent({ smsOptIn: true }, { smsOptIn: false })).toBe(false);
    expect(sameConsent({ smsOptIn: true }, null)).toBe(false);
  });
});

describe('consentLabel', () => {
  it('names what the person allows, and each flag that blocks', () => {
    expect(consentLabel({ smsOptIn: false, emailOptIn: true, doNotContact: true, doNotCall: true, emailBad: true, mobileBad: true }))
      .toBe('Texts: no · Emails: yes · Do not contact · Do not call · Bad email · Bad mobile');
    expect(consentLabel({ smsOptIn: true, doNotContact: false })).toBe('Texts: yes');
  });

  it('is empty when nothing is known', () => {
    expect(consentLabel(null)).toBe('');
    expect(consentLabel({})).toBe('');
  });
});
