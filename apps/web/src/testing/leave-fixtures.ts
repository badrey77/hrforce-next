import type { HttpTestingController } from '@angular/common/http/testing';
import type {
  LeaveBalance,
  LeaveRequestDetail,
  LeaveRequestSummary,
  LeaveType,
  WorkflowProgress,
} from '../app/core/leave/leave.models';
import type { OpenTask } from '../app/core/tasks/tasks.models';

/** Leave types shaped like the contract's seed (docs/contracts/leave.md › Seed). */
export const TYPE_ANNUAL: LeaveType = {
  id: 't-annual',
  code: 'annual',
  labels: { fr: 'Congé annuel', ar: 'عطلة سنوية', en: 'Annual leave' },
  countMode: 'calendar',
  hasBalance: true,
  accrualDaysPerMonth: 2.5,
  maxDaysPerYear: 30,
  maxDaysPerRequest: null,
  oncePerCareer: false,
  requiresDocument: false,
  active: true,
};
export const TYPE_SICK: LeaveType = {
  ...TYPE_ANNUAL,
  id: 't-sick',
  code: 'sick',
  labels: { fr: 'Congé de maladie', ar: 'عطلة مرضية', en: 'Sick leave' },
  countMode: 'working',
  hasBalance: false,
  accrualDaysPerMonth: null,
  maxDaysPerYear: null,
  requiresDocument: true,
};
export const TYPE_OLD: LeaveType = { ...TYPE_ANNUAL, id: 't-old', code: 'old', labels: { fr: 'Ancien', ar: 'قديم', en: 'Old' }, active: false };
export const LEAVE_TYPES: readonly LeaveType[] = [TYPE_ANNUAL, TYPE_SICK, TYPE_OLD];

/** Answers the one `GET /api/leave/types` the LeaveCatalog sends (after a `TestBed.tick()`). */
export function flushLeaveTypes(http: HttpTestingController, items: readonly LeaveType[] = LEAVE_TYPES): void {
  http.expectOne('/api/leave/types').flush({ items });
}

export const BALANCE_2025: LeaveBalance = {
  leaveTypeId: 't-annual',
  periodStart: '2025-07-01',
  accrued: 30,
  taken: -20,
  adjusted: 0,
  balance: 10,
  pending: 2,
  available: 8,
};
export const BALANCE_2026: LeaveBalance = {
  leaveTypeId: 't-annual',
  periodStart: '2026-07-01',
  accrued: 7.5,
  taken: 0,
  adjusted: 1,
  balance: 8.5,
  pending: 0,
  available: 0,
};

export const MANAGER_THEN_HR: WorkflowProgress = {
  status: 'pending',
  currentStep: 1,
  steps: [
    { key: 'manager', kind: 'manager', labels: { fr: 'Responsable', ar: 'المسؤول', en: 'Manager' } },
    { key: 'hr', kind: 'permission', permission: 'leave.approve_hr', labels: { fr: 'RH régionales', ar: 'الموارد البشرية الجهوية', en: 'Regional HR' } },
  ],
};

export const PERSON = { lastName: 'BENALI', firstName: 'Amina', lastNameAr: 'بن علي', firstNameAr: 'أمينة' };

export function leaveSummary(extra: Partial<LeaveRequestSummary> = {}): LeaveRequestSummary {
  return {
    id: 'r-1',
    employee: { id: 'e-1', matricule: 'EMP-0001', person: PERSON, unit: { id: 'a-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' } },
    leaveTypeId: 't-annual',
    startDate: '2026-10-05',
    endDate: '2026-10-09',
    days: 5,
    halfDayStart: false,
    halfDayEnd: false,
    status: 'pending',
    requestedAt: '2026-09-20T08:00:00Z',
    workflow: MANAGER_THEN_HR,
    ...extra,
  };
}

export function leaveDetail(extra: Partial<LeaveRequestDetail> = {}): LeaveRequestDetail {
  return {
    ...leaveSummary(),
    reason: null,
    documentRef: null,
    requestedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    history: [
      {
        id: 'k-1',
        stepKey: 'manager',
        stepIndex: 0,
        status: 'done',
        outcome: 'approve',
        actedBy: { id: 'u-chef', displayName: 'Chef Annaba' },
        actedAt: '2026-09-21T09:30:00Z',
        comment: 'OK',
        createdAt: '2026-09-20T08:00:00Z',
      },
      { id: 'k-2', stepKey: 'hr', stepIndex: 1, status: 'open', outcome: null, actedBy: null, actedAt: null, comment: null, createdAt: '2026-09-21T09:30:00Z' },
    ],
    balances: [BALANCE_2025],
    _actions: [],
    ...extra,
  };
}

export function openTask(id: string, extra: Partial<OpenTask> = {}): OpenTask {
  const summary = leaveSummary({ id: `r-${id}` });
  return {
    id,
    stepKey: 'hr',
    stepIndex: 1,
    stepLabels: MANAGER_THEN_HR.steps[1]?.labels ?? { fr: '', ar: '', en: '' },
    createdAt: '2026-09-21T09:30:00Z',
    subject: {
      type: 'leave_request',
      id: summary.id,
      employee: summary.employee,
      leaveTypeId: summary.leaveTypeId,
      startDate: summary.startDate,
      endDate: summary.endDate,
      days: summary.days,
    },
    ...extra,
  };
}

export function conflict(slug: string, errors?: { field: string; code: string; message: string }[]) {
  return [
    { type: `urn:hrforce:problem:${slug}`, title: 'Conflict', status: 409, ...(errors ? { errors } : {}) },
    { status: 409, statusText: 'Conflict' },
  ] as const;
}
