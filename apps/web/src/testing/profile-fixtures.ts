import type {
  MyProfileView,
  PersonalView,
  ProfileRequestDetail,
  ProfileRequestView,
  ProfileSettings,
} from '../app/core/profile/profile.models';

export function personalView(extra: Partial<PersonalView> = {}): PersonalView {
  return {
    contact: {
      mobilePhone: '+213 555 12 34 56',
      otherPhone: null,
      personalEmail: 'samir.haddad@example.dz',
      addressLine: '12 rue des Jasmins',
      commune: 'Annaba',
      wilayaCode: '23',
      postalCode: '23000',
      updatedAt: '2026-10-01T09:00:00Z',
    },
    emergencyContact: { fullName: 'Nadia Haddad', relationship: 'spouse', phone: '+213 555 98 76 54' },
    family: {
      maritalStatus: 'married',
      maritalStatusSince: '2018-06-30',
      spouseEmployed: 'no',
      children: [{ id: 'ch-1', firstName: 'Yanis', birthDate: '2020-03-14', sex: 'M', dependent: true }],
    },
    ...extra,
  };
}

export function myProfile(extra: Partial<MyProfileView> = {}): MyProfileView {
  return {
    employee: {
      id: 'emp-31',
      matricule: 'EMP-0031',
      person: { lastName: 'Haddad', firstName: 'Samir', lastNameAr: 'حداد', firstNameAr: 'سمير' },
      unit: { id: 'u-annaba', code: 'AG-ANB', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' },
      jobTitle: 'Agent commercial',
      hireDate: '2019-02-01',
    },
    identity: { birthDate: '1990-05-12', birthPlace: 'Annaba', nationality: 'DZ', ninMasked: '•••• 4821' },
    personal: personalView(),
    bank: { ribMasked: '•••• •••• 1234', bankName: 'BNA' },
    modes: { contact: 'immediate', emergency: 'immediate', family: 'approval' },
    pending: [],
    ...extra,
  };
}

export function profileRequest(extra: Partial<ProfileRequestView> = {}): ProfileRequestView {
  const profile = myProfile();
  return {
    id: 'pr-1',
    section: 'family',
    status: 'pending',
    employee: { id: profile.employee.id, matricule: profile.employee.matricule, person: profile.employee.person, unit: profile.employee.unit },
    payload: {
      ...profile.personal.family,
      children: [...profile.personal.family.children, { firstName: 'Lina', birthDate: '2026-09-01', sex: 'F', dependent: true }],
    },
    before: profile.personal.family,
    changedFields: ['children'],
    changedSince: false,
    comment: null,
    files: [{ id: 'pf-1', filename: 'extrait.pdf', mime: 'application/pdf', sizeBytes: 2048, purged: false }],
    requestedAt: '2026-10-20T08:30:00Z',
    decidedAt: null,
    workflow: {
      status: 'pending',
      currentStep: 0,
      steps: [{ key: 'hr', kind: 'permission', permission: 'employee.personal.update', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' }, state: 'current' }],
    },
    rejectionComment: null,
    _actions: ['cancel'],
    ...extra,
  };
}

export function profileRequestDetail(extra: Partial<ProfileRequestDetail> = {}): ProfileRequestDetail {
  return { ...profileRequest(), history: [], ...extra };
}

export const PROFILE_SETTINGS: ProfileSettings = {
  contactMode: 'immediate',
  emergencyMode: 'immediate',
  familyMode: 'approval',
  fileRetentionDays: 30,
};
