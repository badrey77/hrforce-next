import { FormControl, FormGroup } from '@angular/forms';
import { fieldErrorKey } from './employee-forms';
import { contactBody, email, emergencyBody, emergencyComplete, familyBody, notFuture, phone, postalCode } from './personal-forms';

const group = (fullName: string, relationship: string, phoneNumber: string) =>
  new FormGroup({ fullName: new FormControl(fullName), relationship: new FormControl(relationship), phone: new FormControl(phoneNumber) });

describe('personal form rules', () => {
  it('checks phones, e-mails and postal codes; empty values pass', () => {
    expect(phone(new FormControl(''))).toBeNull();
    expect(phone(new FormControl('+213 555 12 34 56'))).toBeNull();
    expect(phone(new FormControl('0555123456'))).toBeNull();
    expect(phone(new FormControl('12-34'))).toEqual({ phone: true });
    expect(phone(new FormControl('1234567'))).toEqual({ phone: true });
    expect(email(new FormControl('a.b@example.dz'))).toBeNull();
    expect(email(new FormControl('a b@x'))).toEqual({ email: true });
    expect(postalCode(new FormControl('23000'))).toBeNull();
    expect(postalCode(new FormControl('2300'))).toEqual({ postalCode: true });
    expect(fieldErrorKey(new FormControl('x', [phone]))).toBe('personal.form.errors.phone');
  });

  it('refuses a date after today', () => {
    const rule = notFuture(() => '2026-10-24');
    expect(rule(new FormControl('2026-10-24'))).toBeNull();
    expect(rule(new FormControl('2026-10-25'))).toEqual({ future: true });
    expect(rule(new FormControl(''))).toBeNull();
  });

  it('wants the emergency contact complete or empty', () => {
    expect(emergencyComplete(group('', '', ''))).toBeNull();
    expect(emergencyComplete(group('Nadia', 'spouse', '0555123456'))).toBeNull();
    expect(emergencyComplete(group('Nadia', '', ''))).toEqual({ emergencyIncomplete: true });
  });

  it('builds the bodies: blanks become null, phones keep single spaces, no id for new children', () => {
    expect(
      contactBody({ mobilePhone: ' +213  555 12 ', otherPhone: '', personalEmail: ' a@b.dz ', addressLine: '', commune: 'Annaba', wilayaCode: '23', postalCode: '' }),
    ).toEqual({ mobilePhone: '+213 555 12', otherPhone: null, personalEmail: 'a@b.dz', addressLine: null, commune: 'Annaba', wilayaCode: '23', postalCode: null });
    expect(emergencyBody({ fullName: ' ', relationship: '', phone: '' })).toBeNull();
    expect(emergencyBody({ fullName: 'Nadia', relationship: 'spouse', phone: '0555 123 456' })).toEqual({ fullName: 'Nadia', relationship: 'spouse', phone: '0555 123 456' });
    expect(
      familyBody({
        maritalStatus: 'married',
        maritalStatusSince: '',
        spouseEmployed: '',
        children: [
          { id: 'ch-1', firstName: ' Yanis ', birthDate: '2020-03-14', sex: 'M', dependent: true },
          { id: '', firstName: 'Lina', birthDate: '2026-09-01', sex: '', dependent: false },
        ],
      }),
    ).toEqual({
      maritalStatus: 'married',
      maritalStatusSince: null,
      spouseEmployed: null,
      children: [
        { id: 'ch-1', firstName: 'Yanis', birthDate: '2020-03-14', sex: 'M', dependent: true },
        { firstName: 'Lina', birthDate: '2026-09-01', sex: null, dependent: false },
      ],
    });
    // no marital status → no date either
    expect(familyBody({ maritalStatus: '', maritalStatusSince: '2020-01-01', spouseEmployed: 'no', children: [] }).maritalStatusSince).toBeNull();
  });
});
