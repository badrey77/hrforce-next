import type { EmployeeDetail, EmployeeListItem, EmployeePage } from '../app/core/employees/employees.models';

/** Fictitious employees shaped like the contract's seed (docs/contracts/employment.md › Seed). */
export const UNIT_ANNABA = { id: 'a-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' };
export const UNIT_ORAN = { id: 'a-oran', code: 'AG-ORAN', name: 'Agence Oran', nameAr: null, kind: 'agency' };

export function listItem(extra: Partial<EmployeeListItem> = {}): EmployeeListItem {
  return {
    id: 'e-1',
    matricule: 'EMP-0001',
    person: { id: 'p-1', lastName: 'BENALI', firstName: 'Amina', lastNameAr: 'بن علي', firstNameAr: 'أمينة' },
    unit: UNIT_ANNABA,
    site: { id: 's-annaba', code: 'ANNABA', name: 'Annaba' },
    jobTitle: 'Chargée de clientèle',
    hireDate: '2024-03-01',
    endDate: null,
    status: 'active',
    ...extra,
  };
}

export function page(items: readonly EmployeeListItem[], total = items.length, pageNo = 1, pageSize = 25): EmployeePage {
  return { items, total, page: pageNo, pageSize };
}

/** An active employee visible with everything (admin_rh_central). */
export function detail(extra: Partial<EmployeeDetail> = {}): EmployeeDetail {
  return {
    ...listItem(),
    person: {
      id: 'p-1',
      lastName: 'BENALI',
      firstName: 'Amina',
      lastNameAr: 'بن علي',
      firstNameAr: 'أمينة',
      birthDate: '1990-05-12',
      birthPlace: 'Annaba',
      sex: 'F',
      nationality: 'DZ',
      nin: '109901234567890123',
      // Consistent with the employment by default: an ended one leaves the person without an open employment.
      hasOpenEmployment: !extra.endDate,
    },
    endReason: null,
    assignments: [
      {
        id: 'as-2',
        unit: { ...UNIT_ANNABA, path: [{ id: 'dg', name: 'Direction Générale' }, { id: 'r-est', name: 'Région Est' }] },
        site: { id: 's-annaba', code: 'ANNABA', name: 'Annaba' },
        siteInherited: true,
        jobTitle: 'Chargée de clientèle',
        validFrom: '2025-01-01',
        validTo: null,
      },
      {
        id: 'as-1',
        unit: { ...UNIT_ORAN, path: [{ id: 'dg', name: 'Direction Générale' }] },
        site: null,
        siteInherited: false,
        jobTitle: 'Guichetière',
        validFrom: '2024-03-01',
        validTo: '2025-01-01',
      },
    ],
    salary: {
      current: { baseSalary: '85000.00', currency: 'DZD', validFrom: '2025-01-01' },
      history: [
        { baseSalary: '85000.00', validFrom: '2025-01-01', validTo: null },
        { baseSalary: '72000.50', validFrom: '2024-03-01', validTo: '2025-01-01' },
      ],
    },
    bank: { rib: '00400123456789012345', bankName: 'BNA' },
    nss: { nss: '901234567890' },
    _redacted: [],
    _actions: ['update', 'assign', 'end', 'update_salary', 'update_bank', 'update_nss'],
    ...extra,
  };
}

/** What `lecture.ouest` would get: no sensitive blocks, no actions. */
export function redactedDetail(extra: Partial<EmployeeDetail> = {}): EmployeeDetail {
  const { salary: _s, bank: _b, nss: _n, ...rest } = detail();
  return { ...rest, _redacted: ['salary', 'bank', 'nss'], _actions: [], ...extra };
}

export function problem(status: number, slug: string | null, errors?: { field: string; code: string; message: string }[]) {
  return [
    { type: slug ? `urn:hrforce:problem:${slug}` : 'about:blank', title: 'Problem', status, ...(errors ? { errors } : {}) },
    { status, statusText: 'Problem' },
  ] as const;
}
