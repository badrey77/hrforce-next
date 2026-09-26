import { DisplayNamePipe, displayNameOf } from './display-name.pipe';

describe('displayName pipe', () => {
  const pipe = new DisplayNamePipe();
  const person = { lastName: 'BENALI', firstName: 'Amina', lastNameAr: 'بن علي', firstNameAr: 'أمينة' };

  it('shows a person as "LAST First", in Arabic only in the Arabic UI', () => {
    expect(pipe.transform(person, 'fr')).toBe('BENALI Amina');
    expect(pipe.transform(person, 'en')).toBe('BENALI Amina');
    expect(pipe.transform(person, 'ar')).toBe('بن علي أمينة');
  });

  it('falls back to Latin when an Arabic part is missing or blank', () => {
    expect(pipe.transform({ ...person, firstNameAr: null }, 'ar')).toBe('BENALI Amina');
    expect(pipe.transform({ ...person, lastNameAr: '  ' }, 'ar')).toBe('BENALI Amina');
  });

  it('shows a unit by nameAr in Arabic when present, else name', () => {
    expect(pipe.transform({ name: 'Agence Oran', nameAr: 'وكالة وهران' }, 'ar')).toBe('وكالة وهران');
    expect(pipe.transform({ name: 'Agence Oran', nameAr: 'وكالة وهران' }, 'fr')).toBe('Agence Oran');
    expect(pipe.transform({ name: 'Agence Oran', nameAr: null }, 'ar')).toBe('Agence Oran');
    expect(pipe.transform({ name: 'Agence Oran' }, 'ar')).toBe('Agence Oran');
  });

  it('renders nothing for a missing value', () => {
    expect(displayNameOf(null, 'fr')).toBe('');
    expect(displayNameOf(undefined, 'ar')).toBe('');
  });
});
