/**
 * Fictitious facts of the designer's sample preview (docs/contracts/document-templates.md › Endpoints, preview
 * `{sample: true}`): « Amine Benali » / « أمين بن علي », two positions held, a leave of 15 days, a sample signatory.
 * The letterhead is the company's own (or the sample below when it is incomplete, for the publish check only).
 * TEST DATA: nothing here is a real person. Pure: no Nest, no Kysely.
 */
import type { EmployeeFacts, LeaveSnapshotFacts, ProfileFacts, SignatoryFacts } from './snapshot.js';
import type { EmploymentRule } from './types.js';

export function sampleEmployee(rule: EmploymentRule): EmployeeFacts & { unitId: string } {
  const ended = rule === 'ended';
  return {
    employmentId: 'sample',
    unitId: 'sample',
    sex: 'M',
    firstName: 'Amine',
    lastName: 'Benali',
    firstNameAr: 'أمين',
    lastNameAr: 'بن علي',
    matricule: 'EMP-0042',
    birthDate: '1988-03-14',
    birthPlace: 'Annaba',
    jobTitle: 'Chargé de clientèle',
    unitName: 'Agence Annaba',
    unitNameAr: 'وكالة عنابة',
    hireDate: '2019-09-01',
    endDate: ended ? '2026-06-30' : null,
    assignments: [
      { jobTitle: 'Agent d’accueil', validFrom: '2019-09-01', validTo: '2022-04-01' },
      { jobTitle: 'Chargé de clientèle', validFrom: '2022-04-01', validTo: ended ? '2026-07-01' : null },
    ],
  };
}

export const SAMPLE_LEAVE: LeaveSnapshotFacts = {
  requestId: 'sample',
  typeLabels: { fr: 'Congé annuel', ar: 'عطلة سنوية' },
  startDate: '2026-10-12',
  endDate: '2026-10-26',
  days: '15',
  halfDayStart: false,
  halfDayEnd: false,
  resumption: { date: '2026-10-27', afternoon: false },
};

export const SAMPLE_SIGNATORY: SignatoryFacts = {
  id: 'sample',
  nameFr: 'Farid Belkacem',
  nameAr: 'فريد بلقاسم',
  titleFr: 'Directeur des ressources humaines',
  titleAr: 'مدير الموارد البشرية',
};

/** Used by the publish check only when the company's letterhead is not complete yet. */
export const SAMPLE_PROFILE: ProfileFacts = {
  legalNameFr: 'Entreprise exemple',
  legalNameAr: 'مؤسسة نموذجية',
  addressFr: '12 rue Didouche Mourad, 16000 Alger',
  addressAr: '12 شارع ديدوش مراد، 16000 الجزائر',
  cityFr: 'Alger',
  cityAr: 'الجزائر',
  phone: '+213 21 00 00 00',
  email: 'rh@exemple.dz',
  nif: '000016000000000',
  nis: null,
  rc: null,
  ai: null,
  footerFr: null,
  footerAr: null,
  hasLogo: false,
};
