import { describe, expect, it } from 'vitest';
import { toFieldErrors } from '../../../platform/http/zod-validation.pipe.js';
import { bankInputSchema, contactInputSchema, emergencyInputSchema, familyInputSchema } from './personal.dto.js';

const contact = { mobilePhone: null, otherPhone: null, personalEmail: null, addressLine: null, commune: null, wilayaCode: null, postalCode: null };

describe('personal-details bodies', () => {
  it('contact: normalises phones, e-mail, wilaya; blanks become null', () => {
    const parsed = contactInputSchema.parse({ ...contact, mobilePhone: '0555 12 34 56', otherPhone: '  ', personalEmail: ' A.B@Exemple.TEST ', wilayaCode: '9', postalCode: '' });
    expect(parsed).toEqual({ ...contact, mobilePhone: '+213555123456', personalEmail: 'a.b@exemple.test', wilayaCode: '09' });
  });

  it('contact: every field has its error code and path', () => {
    const result = contactInputSchema.safeParse({ mobilePhone: '12', otherPhone: 'abc', personalEmail: 'x@', addressLine: 'a'.repeat(201), commune: 'c'.repeat(81), wilayaCode: '59', postalCode: '1600' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toFieldErrors(result.error.issues, 'payload').map((e) => `${e.field}:${e.code}`)).toEqual([
      'payload.mobilePhone:invalid_phone',
      'payload.otherPhone:invalid_phone',
      'payload.personalEmail:invalid_email',
      'payload.addressLine:too_big',
      'payload.commune:too_big',
      'payload.wilayaCode:invalid_wilaya',
      'payload.postalCode:invalid_postal_code',
    ]);
  });

  it('emergency contact: name, relationship, phone required', () => {
    expect(emergencyInputSchema.parse({ fullName: ' Samir Haddad ', relationship: 'sibling', phone: '0661 00 00 01' })).toEqual({ fullName: 'Samir Haddad', relationship: 'sibling', phone: '+213661000001' });
    const r = emergencyInputSchema.safeParse({ fullName: '', relationship: 'cousin', phone: '' });
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual(['fullName', 'relationship', 'phone']);
  });

  it('family: children paths, enums, dates', () => {
    const r = familyInputSchema.safeParse({ maritalStatus: 'engaged', maritalStatusSince: '2020-13-01', spouseEmployed: null, children: [{ firstName: 'Lina', birthDate: '2018-01-01', sex: null, dependent: true }, { firstName: '', birthDate: 'x', sex: 'X', dependent: 'yes' }] });
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual(['maritalStatus', 'maritalStatusSince', 'children.1.firstName', 'children.1.birthDate', 'children.1.sex', 'children.1.dependent']);
  });

  it('bank: 20 digits (spaces ignored) and a bank name', () => {
    expect(bankInputSchema.parse({ rib: '0079 9999 0000 0000 0028', bankName: 'BNA' })).toEqual({ rib: '00799999000000000028', bankName: 'BNA' });
    expect(bankInputSchema.safeParse({ rib: '123', bankName: '' }).success).toBe(false);
  });
});
