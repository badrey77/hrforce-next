import type { WorkflowProgress } from '../app/core/leave/leave.models';
import type {
  AttendanceDayView,
  CorrectionDetail,
  CorrectionView,
  MonthlyReportView,
  Counts,
  EmployeeDaysView,
  KioskQrView,
  KioskSessionView,
  KioskView,
  MyDaysView,
  PresenceBoardView,
  PunchView,
  ScheduleView,
} from '../app/core/attendance/attendance.models';
import { addDays, algiersToday, standardWeek } from '../app/core/attendance/attendance.models';

export const EMPLOYEE_REF = {
  id: 'e-30',
  matricule: 'EMP-0030',
  person: { lastName: 'SAIDI', firstName: 'Nadia', lastNameAr: 'سعيدي', firstNameAr: 'نادية' },
  unit: { id: 'a-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' },
  site: { id: 's-annaba', code: 'ANNABA', name: 'Annaba' },
};

export const KIOSK_LABELS = { fr: 'Agence Annaba — Entrée', ar: 'وكالة عنابة — المدخل' };

export function punch(extra: Partial<PunchView> = {}): PunchView {
  return {
    id: 'p-1',
    direction: 'in',
    occurredAt: '2026-09-29T06:52:00Z',
    localTime: '07:52',
    workDate: '2026-09-29',
    source: 'qr',
    kiosk: { id: 'k-annaba', labels: KIOSK_LABELS, site: EMPLOYEE_REF.site },
    site: EMPLOYEE_REF.site,
    reason: null,
    createdBy: null,
    correctionId: null,
    status: 'live',
    void: null,
    _actions: [],
    ...extra,
  };
}

export function day(extra: Partial<AttendanceDayView> = {}): AttendanceDayView {
  return {
    date: '2026-09-29',
    employee: EMPLOYEE_REF,
    status: 'present',
    final: false,
    schedule: {
      scheduleId: 'sch-agence',
      code: 'agence',
      labels: { fr: 'Agence — accueil du public', ar: 'الوكالة — استقبال الجمهور', en: 'Branch hours' },
      source: 'unit',
      override: null,
      start: '07:30',
      end: '16:00',
      breakStart: '12:00',
      breakEnd: '12:30',
      expectedStart: '07:30',
      expectedEnd: '16:00',
      toleranceMinutes: 10,
      scheduledMinutes: 480,
    },
    arrival: { id: 'p-1', occurredAt: '2026-09-29T06:52:00Z', localTime: '07:52' },
    departure: null,
    lateMinutes: 22,
    earlyDepartureMinutes: 0,
    workedMinutes: 95,
    flags: ['open'],
    leave: null,
    holiday: null,
    ...extra,
  };
}

export const TOTALS = {
  workedMinutes: 2400,
  scheduledMinutes: 2880,
  lateDays: 1,
  lateMinutes: 22,
  absentDays: 1,
  incompleteDays: 0,
  leaveDays: 0,
  earlyDepartureDays: 0,
};

export function myDays(items: readonly AttendanceDayView[] = [day()], extra: Partial<MyDaysView> = {}): MyDaysView {
  return { from: items[0]?.date ?? '2026-09-29', to: items.at(-1)?.date ?? '2026-09-29', employee: EMPLOYEE_REF, items, totals: TOTALS, retentionMonths: 60, correctionWindow: { from: addDays(algiersToday(), -30), to: algiersToday() }, ...extra };
}

export function employeeDays(items: readonly AttendanceDayView[], canManage = true): EmployeeDaysView {
  return { ...myDays(items), canManage };
}

export function counts(extra: Partial<Counts> = {}): Counts {
  return { present: 12, late: 3, absent: 1, incomplete: 0, expected: 2, on_leave: 1, holiday: 0, rest_day: 0, total: 19, ...extra };
}

export function board(items: readonly AttendanceDayView[] = [day()], extra: Partial<PresenceBoardView> = {}): PresenceBoardView {
  return { date: '2026-09-29', final: false, asOf: '2026-09-29T08:00:00Z', counts: counts(), items, total: items.length, page: 1, pageSize: 50, ...extra };
}

export function kioskView(extra: Partial<KioskView> = {}): KioskView {
  return {
    id: 'k-hq',
    kind: 'qr_kiosk',
    labels: { fr: 'Siège — Entrée principale', ar: 'المقر — المدخل الرئيسي' },
    site: { id: 's-hq', code: 'ALG-HQ', name: 'Alger – Siège' },
    status: 'active',
    allowedNetworks: [],
    pairedAt: '2026-09-20T08:00:00Z',
    pairing: null,
    lastSeen: { at: '2026-09-29T07:58:00Z', ip: '41.200.10.4', userAgent: 'Chrome' },
    createdAt: '2026-09-20T07:00:00Z',
    createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
    revoked: null,
    _actions: ['update', 'pair', 'revoke'],
    ...extra,
  };
}

export function scheduleView(extra: Partial<ScheduleView> = {}): ScheduleView {
  const week = standardWeek();
  return {
    id: 'sch-standard',
    code: 'standard',
    labels: { fr: 'Horaire standard', ar: 'التوقيت العادي', en: 'Standard hours' },
    active: true,
    versions: [{ id: 'v-1', validFrom: '2000-01-01', validTo: null, week, toleranceMinutes: 10 }],
    current: { validFrom: '2000-01-01', week, toleranceMinutes: 10, weeklyMinutes: 2400 },
    assignmentCount: 1,
    ...extra,
  };
}

export function kioskSession(serverTime: string): KioskSessionView {
  return {
    kiosk: { id: 'k-hq', labels: { fr: 'Siège — Entrée principale', ar: 'المقر — المدخل الرئيسي' }, site: { code: 'ALG-HQ', name: 'Alger – Siège' } },
    company: { name: 'Groupe Démo' },
    serverTime,
    windowSeconds: 30,
  };
}

/** The four windows starting at the one containing `serverTime` (windows aligned on 30 s like the API's). */
export function kioskQr(serverTime: string): KioskQrView {
  const now = Date.parse(serverTime);
  const start = Math.floor(now / 30_000) * 30_000;
  return {
    serverTime,
    windowSeconds: 30,
    windows: Array.from({ length: 4 }, (_, i) => ({
      window: start / 30_000 + i,
      qr: `http://localhost/punch#token-${start / 30_000 + i}`,
      showFrom: new Date(start + i * 30_000).toISOString(),
      showUntil: new Date(start + (i + 1) * 30_000).toISOString(),
    })),
  };
}

export function attendanceProblem(status: number, slug: string | null, errors?: { field: string; code: string; message: string }[]) {
  return {
    body: { type: slug ? `urn:hrforce:problem:${slug}` : 'about:blank', title: 'Problem', status, ...(errors ? { errors } : {}) },
    options: { status, statusText: 'Problem' },
  };
}

// --- Phase B ----------------------------------------------------------------------------------------------------------

export const MANAGER_THEN_HR_PROGRESS: WorkflowProgress = {
  status: 'pending',
  currentStep: 0,
  steps: [
    { key: 'manager', kind: 'manager', labels: { fr: 'Responsable', ar: 'المسؤول المباشر', en: 'Manager' }, state: 'current' },
    { key: 'hr', kind: 'permission', permission: 'attendance.manage', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' }, state: 'pending' },
  ],
};

export function correctionView(extra: Partial<CorrectionView> = {}): CorrectionView {
  return {
    id: 'c-1',
    date: '2026-09-28',
    reason: 'Téléphone oublié',
    status: 'pending',
    requestedAt: '2026-09-29T08:00:00Z',
    requestedBy: { id: 'u-nadia', displayName: 'Nadia Saidi' },
    employee: EMPLOYEE_REF,
    changes: [
      { position: 0, action: 'add', direction: 'out', time: '16:05', punch: null, resultPunchId: null },
      { position: 1, action: 'void', direction: null, time: null, punch: { id: 'p-0', direction: 'in', localTime: '07:52' }, resultPunchId: null },
    ],
    workflow: MANAGER_THEN_HR_PROGRESS,
    rejectionComment: null,
    _actions: ['cancel'],
    ...extra,
  };
}

export function correctionDetail(extra: Partial<CorrectionDetail> = {}): CorrectionDetail {
  return {
    ...correctionView(),
    history: [],
    day: day({ date: '2026-09-28', final: true, punches: [punch({ id: 'p-0', workDate: '2026-09-28' }), punch({ id: 'p-9', direction: 'in', localTime: '08:01', workDate: '2026-09-28' })] }),
    ...extra,
  };
}

export function monthlyReport(extra: Partial<MonthlyReportView> = {}): MonthlyReportView {
  return {
    month: '2026-09',
    days: 30,
    items: [
      {
        employee: EMPLOYEE_REF,
        counts: { present: 18, late: 2, absent: 1, incomplete: 0, onLeave: 0, holiday: 0, restDay: 8 },
        lateMinutes: 34,
        earlyDepartureMinutes: 0,
        workedMinutes: 9000,
        scheduledMinutes: 9600,
        absentDates: ['2026-09-14'],
        incompleteDates: [],
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
    ...extra,
  };
}
