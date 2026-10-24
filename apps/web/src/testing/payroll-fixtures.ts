import type {
  EmployeeVariables,
  PayrollSettings,
  PeriodSummary,
  PeriodView,
  RubriqueView,
  SettingsPreview,
} from '../app/core/payroll/payroll.models';

export const PAYROLL_EMPLOYEE = {
  id: 'emp-27',
  matricule: 'EMP-0027',
  person: { lastName: 'Benali', firstName: 'Amine', lastNameAr: 'بن علي', firstNameAr: 'أمين' },
  unit: { id: 'u-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' },
  site: null,
};

export const RUBRIQUE_ANNUAL: RubriqueView = {
  id: 'rub-annual',
  source: 'leave',
  leaveType: { id: 'lt-annual', code: 'annual', labels: { fr: 'Congé annuel', ar: 'عطلة سنوية', en: 'Annual leave' } },
  exportCode: 'CG_ANNUEL',
  names: { fr: 'Congé annuel', ar: 'عطلة سنوية', en: 'Annual leave' },
  unit: 'days',
  active: true,
  sortOrder: 10,
};

export const RUBRIQUE_ABSENCE: RubriqueView = {
  id: 'rub-abs',
  source: 'absence',
  leaveType: null,
  exportCode: 'ABS_NJ',
  names: { fr: 'Absence non justifiée', ar: 'غياب غير مبرر', en: 'Unjustified absence' },
  unit: 'days',
  active: true,
  sortOrder: 20,
};

export const RUBRIQUE_PRIME: RubriqueView = {
  id: 'rub-prime',
  source: 'manual',
  leaveType: null,
  exportCode: 'PRIME_REND',
  names: { fr: 'Prime de rendement', ar: 'منحة المردودية', en: 'Performance bonus' },
  unit: 'amount',
  active: true,
  sortOrder: 30,
};

export const RUBRIQUE_LATE: RubriqueView = {
  id: 'rub-late',
  source: 'late',
  leaveType: null,
  exportCode: 'RETARD',
  names: { fr: 'Retards', ar: 'التأخرات', en: 'Lateness' },
  unit: 'hours',
  active: false,
  sortOrder: 40,
};

export const RUBRIQUES: readonly RubriqueView[] = [RUBRIQUE_ANNUAL, RUBRIQUE_ABSENCE, RUBRIQUE_PRIME, RUBRIQUE_LATE];

export const PAYROLL_SETTINGS: PayrollSettings = {
  cutoffDay: 20,
  regularizationMonths: 3,
  overtimeMinMinutes: 30,
  layout: 'per_line',
  separator: 'semicolon',
  decimalSeparator: 'comma',
  encoding: 'windows1252',
  headerRow: true,
  columns: ['matricule', 'rubrique', 'value', 'period'],
  periodFormat: 'mm_yyyy',
  fileExtension: 'csv',
};

export const SETTINGS_PREVIEW: SettingsPreview = {
  filename: 'variables-paie-2026-10.csv',
  encoding: 'windows1252',
  sample: 'matricule;rubrique;valeur;periode\r\nEMP-0027;CG_ANNUEL;3;10/2026\r\n',
};

export const OPEN_PERIOD_SUMMARY: PeriodSummary = {
  month: '2026-10',
  status: 'open',
  cutoffDate: '2026-10-20',
  version: null,
  closedAt: null,
  closedBy: null,
};

export const CLOSED_PERIOD_SUMMARY: PeriodSummary = {
  month: '2026-09',
  status: 'closed',
  cutoffDate: '2026-09-20',
  version: 1,
  closedAt: '2026-10-02T09:15:00Z',
  closedBy: { id: 'u-admin', displayName: 'Admin RH' },
};

export const OPEN_PERIOD: PeriodView = {
  ...OPEN_PERIOD_SUMMARY,
  employees: 42,
  lines: 57,
  totals: [
    { rubriqueId: RUBRIQUE_ANNUAL.id, exportCode: 'CG_ANNUEL', names: RUBRIQUE_ANNUAL.names, unit: 'days', employees: 12, total: 34.5 },
    { rubriqueId: RUBRIQUE_ABSENCE.id, exportCode: 'ABS_NJ', names: RUBRIQUE_ABSENCE.names, unit: 'days', employees: 3, total: 4 },
  ],
  regularizations: 1,
  flags: { incompleteDays: 12, pendingLeave: 3, noAttendance: 5 },
  closings: [],
  _actions: ['close', 'export_draft'],
};

export const CLOSED_PERIOD: PeriodView = {
  ...CLOSED_PERIOD_SUMMARY,
  employees: 41,
  lines: 50,
  totals: [],
  regularizations: 0,
  flags: { incompleteDays: 0, pendingLeave: 0, noAttendance: 5 },
  closings: [{ version: 1, closedAt: '2026-10-02T09:15:00Z', closedBy: { id: 'u-admin', displayName: 'Admin RH' }, reopenedAt: null, reopenedBy: null, reopenReason: null }],
  _actions: ['reopen', 'export'],
};

export const EMPLOYEE_VARIABLES: EmployeeVariables = {
  employee: PAYROLL_EMPLOYEE,
  payrollCode: 'P-0027',
  entry: null,
  exit: null,
  flags: ['pending_leave'],
  incompleteDays: 0,
  lines: [
    { rubriqueId: RUBRIQUE_ANNUAL.id, exportCode: 'CG_ANNUEL', names: RUBRIQUE_ANNUAL.names, unit: 'days', source: 'leave', originMonth: '2026-10', computed: 3, value: 3, adjusted: false, note: null },
    { rubriqueId: RUBRIQUE_ABSENCE.id, exportCode: 'ABS_NJ', names: RUBRIQUE_ABSENCE.names, unit: 'days', source: 'absence', originMonth: '2026-09', computed: -1, value: -1, adjusted: false, note: null },
  ],
  _actions: ['edit'],
};
