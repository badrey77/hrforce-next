import { describe, expect, it } from 'vitest';
import { chooseSignatory, checkEmploymentFor, coveringSignatories } from './rules.js';
import { buildSnapshot, dateText, daysText, missingProfileFields, positionsOf, type EmployeeFacts, type ProfileFacts } from './snapshot.js';
import { DocumentRuleViolation } from './types.js';

const profile: ProfileFacts = {
  legalNameFr: 'Entreprise Démo',
  legalNameAr: 'مؤسسة تجريبية',
  addressFr: '12 rue Didouche Mourad, Alger',
  addressAr: '12 شارع ديدوش مراد، الجزائر',
  cityFr: 'Alger',
  cityAr: 'الجزائر',
  phone: '+213 21 00 00 00',
  email: null,
  nif: '000016000000000',
  nis: null,
  rc: '16/00-0000000 B 26',
  ai: null,
  footerFr: 'Données de test',
  footerAr: null,
  hasLogo: false,
};

const employee: EmployeeFacts = {
  employmentId: 'e1',
  sex: 'F',
  firstName: 'Amina',
  lastName: 'Benali',
  firstNameAr: 'أمينة',
  lastNameAr: null,
  matricule: 'EMP-0042',
  birthDate: '1990-03-01',
  birthPlace: 'Annaba',
  jobTitle: 'Chargée de clientèle',
  unitName: 'Agence Annaba',
  unitNameAr: 'وكالة عنابة',
  hireDate: '2019-09-01',
  endDate: null,
  assignments: [{ jobTitle: 'Chargée de clientèle', validFrom: '2019-09-01', validTo: null }],
};

const signatory = { id: 's1', nameFr: 'Souad Cherif', nameAr: 'سعاد شريف', titleFr: 'Directrice régionale', titleAr: 'المديرة الجهوية' };

describe('text formatting', () => {
  it('dates: French with 1er, Arabic with Algerian month names and Western digits', () => {
    expect(dateText('2026-09-28', 'fr')).toBe('28 septembre 2026');
    expect(dateText('2026-02-01', 'fr')).toBe('1er février 2026');
    expect(dateText('2026-09-28', 'ar')).toBe('28 سبتمبر 2026');
    expect(['01', '02', '04', '06', '07', '08'].map((m) => dateText(`2026-${m}-05`, 'ar').split(' ')[1])).toEqual(['جانفي', 'فيفري', 'أفريل', 'جوان', 'جويلية', 'أوت']);
  });

  it('days: comma in French, point in Arabic', () => {
    expect(daysText('2.5', 'fr')).toBe('2,5');
    expect(daysText('2.5', 'ar')).toBe('2.5');
    expect(daysText('30.0', 'fr')).toBe('30');
  });
});

describe('buildSnapshot', () => {
  it('attestation in French: Latin names, civility, identifiers, no salary anywhere', () => {
    const s = buildSnapshot({ type: 'attestation_travail', lang: 'fr', issueDate: '2026-09-28', profile, employee, signatory });
    expect(s).toMatchObject({
      v: 1,
      type: 'attestation_travail',
      lang: 'fr',
      number: '',
      issueDateText: '28 septembre 2026',
      company: { legalName: 'Entreprise Démo', city: 'Alger', footer: 'Données de test', ids: [{ label: 'NIF', value: '000016000000000' }, { label: 'RC', value: '16/00-0000000 B 26' }] },
      employee: { civility: 'Mme', sex: 'F', fullName: 'Amina Benali', birthDateText: '1er mars 1990', birthPlace: 'Annaba', hireDateText: '1er septembre 2019', unitName: 'Agence Annaba' },
      signatory: { name: 'Souad Cherif', title: 'Directrice régionale' },
      ref: { employmentId: 'e1', signatoryId: 's1' },
    });
    expect(JSON.stringify(s)).not.toMatch(/salary|salaire|nss|rib/i);
  });

  it('attestation in Arabic: Arabic name parts with Latin fallback, Arabic unit, Arabic labels', () => {
    const s = buildSnapshot({ type: 'attestation_travail', lang: 'ar', issueDate: '2026-09-28', profile, employee: { ...employee, sex: null }, signatory });
    expect(s.employee.fullName).toBe('أمينة Benali');
    expect(s.employee.civility).toBe('السيد(ة)');
    expect(s.employee.unitName).toBe('وكالة عنابة');
    expect(s.company.legalName).toBe('مؤسسة تجريبية');
    expect(s.company.footer).toBeNull();
    expect(s.company.ids[0]).toEqual({ label: 'رقم التعريف الجبائي', value: '000016000000000' });
    expect(s.signatory.name).toBe('سعاد شريف');
  });

  it('omits the birth clause when the birth date is unknown', () => {
    const s = buildSnapshot({ type: 'attestation_travail', lang: 'fr', issueDate: '2026-09-28', profile, employee: { ...employee, birthDate: null }, signatory });
    expect(s.employee.birthDateText).toBeNull();
    expect(s.employee.birthPlace).toBeNull();
  });

  it('certificat: consecutive distinct positions, to the end date', () => {
    const ended: EmployeeFacts = {
      ...employee,
      endDate: '2026-06-30',
      assignments: [
        { jobTitle: 'Agent', validFrom: '2019-09-01', validTo: '2021-01-01' },
        { jobTitle: 'Agent', validFrom: '2021-01-01', validTo: '2022-04-01' },
        { jobTitle: 'Chef d’agence', validFrom: '2022-04-01', validTo: '2026-07-01' },
      ],
    };
    const s = buildSnapshot({ type: 'certificat_travail', lang: 'fr', issueDate: '2026-07-02', profile, employee: ended, signatory });
    expect(s.employee.endDateText).toBe('30 juin 2026');
    expect(s.employee.positions).toEqual([
      { jobTitle: 'Agent', fromText: '1er septembre 2019', toText: '31 mars 2022' },
      { jobTitle: 'Chef d’agence', fromText: '1er avril 2022', toText: '30 juin 2026' },
    ]);
    expect(positionsOf([], '2026-06-30')).toEqual([]);
  });

  it('titre de congé: leave facts, half days, resumption', () => {
    const s = buildSnapshot({
      type: 'titre_conge',
      lang: 'fr',
      issueDate: '2026-09-28',
      profile,
      employee,
      signatory,
      leave: {
        requestId: 'r1',
        typeLabels: { fr: 'Congé annuel', ar: 'العطلة السنوية' },
        startDate: '2026-10-12',
        endDate: '2026-10-14',
        days: '2.5',
        halfDayStart: false,
        halfDayEnd: true,
        resumption: { date: '2026-10-14', afternoon: true },
      },
    });
    expect(s.leave).toEqual({
      typeLabel: 'Congé annuel',
      startText: '12 octobre 2026',
      endText: '14 octobre 2026',
      days: '2,5',
      halfDayStart: false,
      halfDayEnd: true,
      resumptionText: '14 octobre 2026 après-midi',
    });
    expect(s.ref.leaveRequestId).toBe('r1');
  });

  it('removes bidi embedding/override/isolate controls from every printed value (an unterminated RLO would mirror the sentence)', () => {
    const [rlo, lro, pdf, rli, pdi, rlm] = [0x202e, 0x202d, 0x202c, 0x2067, 0x2069, 0x200f].map((c) => String.fromCharCode(c));
    const s = buildSnapshot({
      type: 'attestation_travail',
      lang: 'fr',
      issueDate: '2026-09-28',
      profile: { ...profile, legalNameFr: `Entreprise ${rlo}Démo`, addressFr: `${rli}12 rue${pdi} Didouche` },
      employee: { ...employee, lastName: `Benali${lro}`, jobTitle: `Agent${pdf}${rlm}` },
      signatory,
    });
    expect(s.company.legalName).toBe('Entreprise Démo');
    expect(s.company.address).toBe('12 rue Didouche');
    expect(s.employee.fullName).toBe('Amina Benali');
    expect(s.employee.jobTitle).toBe(`Agent${rlm}`);
  });

  it('profile completeness per language', () => {
    expect(missingProfileFields(profile, 'fr')).toEqual([]);
    expect(missingProfileFields({ ...profile, cityAr: null, legalNameAr: null }, 'ar')).toEqual(['legalNameAr', 'cityAr']);
    expect(missingProfileFields(null, 'fr')).toEqual(['legalNameFr', 'addressFr', 'cityFr']);
  });
});

describe('rules', () => {
  it('attestation needs an active employment on the issue date; certificat an ended one', () => {
    expect(() => checkEmploymentFor('attestation_travail', { endDate: null }, '2026-09-28')).not.toThrow();
    expect(() => checkEmploymentFor('attestation_travail', { endDate: '2026-09-28' }, '2026-09-28')).not.toThrow();
    expect(() => checkEmploymentFor('attestation_travail', { endDate: '2026-09-27' }, '2026-09-28')).toThrow(expect.objectContaining({ slug: 'document-employment-ended' }));
    expect(() => checkEmploymentFor('certificat_travail', { endDate: null }, '2026-09-28')).toThrow(expect.objectContaining({ slug: 'document-employment-not-ended' }));
    expect(() => checkEmploymentFor('certificat_travail', { endDate: '2026-09-29' }, '2026-09-28')).toThrow(DocumentRuleViolation);
    expect(() => checkEmploymentFor('certificat_travail', { endDate: '2026-09-28' }, '2026-09-28')).not.toThrow();
  });

  const ancestors = new Map([
    ['agency', 0],
    ['region', 1],
    ['dg', 2],
  ]);
  const signatories = [
    { id: 'company', orgUnitId: null, active: true },
    { id: 'region', orgUnitId: 'region', active: true },
    { id: 'other-region', orgUnitId: 'west', active: true },
    { id: 'old', orgUnitId: 'agency', active: false },
  ];

  it('covering signatories: nearest first, company-wide last, inactive and other branches excluded', () => {
    expect(coveringSignatories(signatories, ancestors).map((s) => s.id)).toEqual(['region', 'company']);
  });

  it('chooses the requested one, else the type default when it covers, else the nearest', () => {
    expect(chooseSignatory(signatories, ancestors, 'company', null).id).toBe('company');
    expect(chooseSignatory(signatories, ancestors, undefined, 'company').id).toBe('company');
    expect(chooseSignatory(signatories, ancestors, undefined, 'other-region').id).toBe('region');
    expect(chooseSignatory(signatories, ancestors, undefined, null).id).toBe('region');
    expect(() => chooseSignatory(signatories, ancestors, 'other-region', null)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => chooseSignatory(signatories, ancestors, 'old', null)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => chooseSignatory([], ancestors, undefined, null)).toThrow(expect.objectContaining({ slug: 'document-no-signatory' }));
  });
});
