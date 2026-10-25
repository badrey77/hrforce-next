import { describe, expect, it } from 'vitest';
import {
  familyErrors,
  isValidEmail,
  isValidPhone,
  maskLast4,
  normalizePhone,
  normalizeWilaya,
  planChildren,
  sameContact,
  sameEmergency,
  EMPTY_CONTACT,
  type FamilyInput,
} from './personal.js';

const TODAY = '2026-10-24';
const family = (over: Partial<FamilyInput> = {}): FamilyInput => ({ maritalStatus: 'married', maritalStatusSince: '2015-06-01', spouseEmployed: 'yes', children: [], ...over });
const child = (over: Partial<FamilyInput['children'][number]> = {}) => ({ firstName: 'Lina', birthDate: '2018-03-02', sex: 'F' as const, dependent: true, ...over });

describe('phones', () => {
  it('normalises spaces, 00 and Algerian national numbers', () => {
    expect(normalizePhone('0555 12 34 56')).toBe('+213555123456');
    expect(normalizePhone('+213 555 12 34 56')).toBe('+213555123456');
    expect(normalizePhone('00 33 6 12 34 56 78')).toBe('+33612345678');
    expect(normalizePhone('021 23 45 67')).toBe('021234567'); // 0 + 8 digits: not a national number, kept
    expect(normalizePhone('12345678')).toBe('12345678');
  });

  it('accepts digits, spaces and a leading +, 8–20 characters', () => {
    expect(isValidPhone('0555123456')).toBe(true);
    expect(isValidPhone('+213 555 12 34 56')).toBe(true);
    expect(isValidPhone('1234567')).toBe(false);
    expect(isValidPhone('0555-12-34-56')).toBe(false);
    expect(isValidPhone('+213 555 12 34 56 78 90')).toBe(false); // 23 characters
    expect(isValidPhone('55 5+123456')).toBe(false);
    expect(isValidPhone('00 1234 56')).toBe(false); // 8 typed, 6 digits once `00` → `+`
  });
});

describe('e-mail and address codes', () => {
  it('e-mail: simple pattern, ≤ 254 characters', () => {
    expect(isValidEmail('Amina.Benali@Exemple.test')).toBe(true);
    expect(isValidEmail('amina@exemple')).toBe(false);
    expect(isValidEmail('amina exemple@x.dz')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@x.dz`)).toBe(false);
  });

  it('wilaya: a one-digit number gets its leading zero', () => {
    expect(normalizeWilaya('9')).toBe('09');
    expect(normalizeWilaya('16')).toBe('16');
    expect(normalizeWilaya(' 58 ')).toBe('58');
  });
});

describe('familyErrors', () => {
  it('valid input → no error', () => {
    expect(familyErrors(family({ children: [child()] }), new Set(), TODAY)).toEqual([]);
  });

  it('future dates, a date without status, unknown or repeated child ids, more than 15 children', () => {
    const known = '0190a5d0-0000-7000-8e01-000000000001';
    const errors = familyErrors(
      family({
        maritalStatus: null,
        maritalStatusSince: '2027-01-01',
        children: [child({ birthDate: '2026-10-25' }), child({ id: 'ffffffff-0000-7000-8000-000000000000' }), child({ id: known }), child({ id: known })],
      }),
      new Set([known]),
      TODAY,
    );
    expect(errors.map((e) => `${e.field}:${e.code}`)).toEqual([
      'maritalStatusSince:status_required',
      'maritalStatusSince:future_date',
      'children.0.birthDate:future_date',
      'children.1.id:not_found',
      'children.3.id:not_found',
    ]);
    const many = family({ children: Array.from({ length: 16 }, () => child()) });
    expect(familyErrors(many, new Set(), TODAY)).toEqual([{ field: 'children', code: 'too_many', message: 'At most 15 children.' }]);
    expect(familyErrors(family({ children: Array.from({ length: 15 }, () => child()) }), new Set(), TODAY)).toEqual([]);
  });

  it('today is not in the future', () => {
    expect(familyErrors(family({ maritalStatusSince: TODAY, children: [child({ birthDate: TODAY })] }), new Set(), TODAY)).toEqual([]);
  });
});

describe('planChildren', () => {
  const a = { id: 'a', firstName: 'Adam', birthDate: '2015-01-01', sex: 'M' as const, dependent: true };
  const b = { id: 'b', firstName: 'Lina', birthDate: '2018-01-01', sex: 'F' as const, dependent: true };

  it('updates changed ids, inserts new items, removes missing ones, leaves unchanged ones alone', () => {
    const plan = planChildren([a, b], [{ ...a }, { ...b, dependent: false }, child({ firstName: 'Rayan' })]);
    expect(plan.update).toEqual([{ id: 'b', firstName: 'Lina', birthDate: '2018-01-01', sex: 'F', dependent: false }]);
    expect(plan.insert).toEqual([{ firstName: 'Rayan', birthDate: '2018-03-02', sex: 'F', dependent: true }]);
    expect(plan.remove).toEqual([]);
    expect(planChildren([a, b], [{ ...b }]).remove).toEqual([a]);
    expect(planChildren([a, b], [])).toEqual({ insert: [], update: [], remove: [a, b] });
  });
});

describe('comparisons and masking', () => {
  it('sameContact / sameEmergency', () => {
    expect(sameContact(EMPTY_CONTACT, { ...EMPTY_CONTACT })).toBe(true);
    expect(sameContact(EMPTY_CONTACT, { ...EMPTY_CONTACT, commune: 'Annaba' })).toBe(false);
    const e = { fullName: 'Samir Haddad', relationship: 'sibling' as const, phone: '+213555000001' };
    expect(sameEmergency(e, { ...e })).toBe(true);
    expect(sameEmergency(e, null)).toBe(false);
    expect(sameEmergency(null, null)).toBe(true);
  });

  it('maskLast4 keeps the last 4 digits only', () => {
    expect(maskLast4('00799999000000000028')).toBe('•••• •••• 0028');
    expect(maskLast4(null)).toBeNull();
  });
});
