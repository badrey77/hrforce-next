/**
 * Response shapes of the attendance endpoints (docs/contracts/attendance.md › Endpoints, the TypeScript block).
 * No key of any shape may match /(password|hash|token|secret)/i (CONVENTIONS.md › Security).
 */
import type { DayFlag, DayStatus } from '../domain/day.js';
import type { ScheduleSource, TargetKind } from '../domain/schedules.js';
import type { WeekDay } from '../domain/week.js';
import type { TaskHistoryView, WorkflowProgressView } from '../../workflow/index.js';

export type Labels = { fr: string; ar: string; en: string };
export type LabelPair = { fr: string; ar: string };

export interface UserRef {
  id: string;
  /** the id itself for a former member */
  displayName: string;
}

export interface SiteRef {
  id: string;
  code: string;
  name: string;
}

export interface UnitRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
}

export interface NamePair {
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
}

export interface EmployeeRef {
  id: string;
  matricule: string;
  person: NamePair;
  unit: UnitRef;
  site: SiteRef | null;
}

export interface PunchTime {
  id: string;
  occurredAt: string;
  localTime: string;
}

export interface DaySchedule {
  scheduleId: string;
  code: string;
  labels: Labels;
  source: ScheduleSource;
  override: { id: string; labels: Labels; approximate: boolean } | null;
  start: string | null;
  end: string | null;
  breakStart: string | null;
  breakEnd: string | null;
  expectedStart: string | null;
  expectedEnd: string | null;
  toleranceMinutes: number;
  scheduledMinutes: number;
}

export interface PunchView {
  id: string;
  direction: 'in' | 'out';
  occurredAt: string;
  localTime: string;
  workDate: string;
  source: 'qr' | 'manual' | 'correction';
  kiosk: { id: string; labels: LabelPair; site: SiteRef } | null;
  site: SiteRef | null;
  reason: string | null;
  createdBy: UserRef | null;
  correctionId: string | null;
  status: 'live' | 'void';
  void: { at: string; by: UserRef | null; reason: string; correctionId: string | null } | null;
  _actions: 'void'[];
}

export interface AttendanceDayView {
  date: string;
  employee: EmployeeRef;
  status: DayStatus;
  final: boolean;
  schedule: DaySchedule | null;
  arrival: PunchTime | null;
  departure: PunchTime | null;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  workedMinutes: number;
  flags: DayFlag[];
  leave: { requestId: string; type: { code: string; labels: Labels }; part: 'full' | 'morning' | 'afternoon' } | null;
  holiday: { labels: Labels; approximate: boolean } | null;
  punches?: PunchView[];
}

export type Counts = Record<Exclude<DayStatus, 'not_employed'>, number> & { total: number };

export interface PresenceBoardView {
  date: string;
  final: boolean;
  asOf: string;
  counts: Counts;
  items: AttendanceDayView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TeamPresenceView extends PresenceBoardView {
  units: UnitRef[];
}

export interface DayTotals {
  workedMinutes: number;
  scheduledMinutes: number;
  lateDays: number;
  lateMinutes: number;
  absentDays: number;
  incompleteDays: number;
  leaveDays: number;
  earlyDepartureDays: number;
}

export interface MyDaysView {
  from: string;
  to: string;
  employee: EmployeeRef;
  items: AttendanceDayView[];
  totals: DayTotals;
  retentionMonths: number;
  /**
   * Phase B: the days a correction may be asked for today — [max(today − correctionMaxAgeDays, hire date),
   * min(today, employment end)]; null when that range is empty (the employment ended before it)
   */
  correctionWindow: { from: string; to: string } | null;
}

export interface EmployeeDaysView extends MyDaysView {
  canManage: boolean;
}

export interface ScheduleSegmentsView {
  items: {
    from: string;
    to: string;
    schedule: { id: string; code: string; labels: Labels };
    source: ScheduleSource;
    sourceRef: { kind: 'employment' | 'unit' | 'site'; id: string; code: string; name: string } | null;
    overrides: { id: string; labels: Labels; from: string; to: string }[];
  }[];
}

export interface PolicyView {
  retentionMonths: number;
  minPunchGapSeconds: number;
  correctionMaxAgeDays: number;
  correctionWorkflowCode: 'attendance.manager_then_hr' | 'attendance.hr_only';
}

export interface ScheduleView {
  id: string;
  code: string;
  labels: Labels;
  active: boolean;
  versions: { id: string; validFrom: string; validTo: string | null; week: WeekDay[]; toleranceMinutes: number }[];
  current: { validFrom: string; week: WeekDay[]; toleranceMinutes: number; weeklyMinutes: number } | null;
  assignmentCount: number;
}

export interface OverrideView {
  id: string;
  schedule: { id: string; code: string; labels: Labels } | null;
  labels: Labels;
  from: string;
  to: string;
  week: WeekDay[];
  toleranceMinutes: number;
  approximate: boolean;
}

export interface AssignmentView {
  id: string;
  schedule: { id: string; code: string; labels: Labels };
  target: { kind: TargetKind; id: string | null; code: string | null; name: string | null };
  validFrom: string;
  validTo: string | null;
  _actions: ('end' | 'delete')[];
}

export interface KioskView {
  id: string;
  kind: 'qr_kiosk';
  labels: LabelPair;
  site: SiteRef;
  status: 'pending' | 'active' | 'revoked';
  allowedNetworks: string[];
  pairedAt: string | null;
  pairing: { expiresAt: string } | null;
  lastSeen: { at: string; ip: string; userAgent: string } | null;
  createdAt: string;
  createdBy: UserRef | null;
  revoked: { at: string; by: UserRef | null; reason: string } | null;
  _actions: ('update' | 'pair' | 'revoke')[];
}

export interface PairingCodeView {
  /** "K7M2-9QXA" — shown once */
  code: string;
  expiresAt: string;
}

export interface KioskSessionView {
  kiosk: { id: string; labels: LabelPair; site: { code: string; name: string } };
  company: { name: string };
  serverTime: string;
  windowSeconds: 30;
}

export interface KioskQrView {
  serverTime: string;
  windowSeconds: 30;
  windows: { window: number; qr: string; showFrom: string; showUntil: string }[];
}

export interface ScanView {
  kiosk: { labels: LabelPair; site: { code: string; name: string } };
  scannedAt: string;
  localTime: string;
  receiptExpiresAt: string;
}

export interface PunchResultView {
  punch: PunchView;
  duplicate: boolean;
  day: AttendanceDayView;
}

// ── Phase B: corrections, monthly report; the scan receipt shown before the one-tap confirmation ─────────────────────

export type CorrectionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface CorrectionChangeView {
  position: number;
  action: 'add' | 'void';
  /** add: the requested direction; void: null */
  direction: 'in' | 'out' | null;
  /** add: the requested time "HH:MM" (Algiers); void: null */
  time: string | null;
  /** void: the targeted punch */
  punch: { id: string; direction: 'in' | 'out'; localTime: string } | null;
  /** add, once approved: the punch it created */
  resultPunchId: string | null;
}

export interface CorrectionView {
  id: string;
  date: string;
  reason: string;
  status: CorrectionStatus;
  requestedAt: string;
  requestedBy: UserRef | null;
  employee: EmployeeRef;
  changes: CorrectionChangeView[];
  /** null only for a correction without a workflow instance (never through the API) */
  workflow: WorkflowProgressView | null;
  rejectionComment: string | null;
  _actions: 'cancel'[];
}

export interface CorrectionDetailView extends CorrectionView {
  history: TaskHistoryView[];
  /** the day as computed now, with its punches (void included, their _actions always []) */
  day: AttendanceDayView;
}

export interface CorrectionPage {
  items: CorrectionView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MonthlyReportItem {
  employee: EmployeeRef;
  counts: { present: number; late: number; absent: number; incomplete: number; onLeave: number; holiday: number; restDay: number };
  lateMinutes: number;
  earlyDepartureMinutes: number;
  workedMinutes: number;
  scheduledMinutes: number;
  absentDates: string[];
  incompleteDates: string[];
}

export interface MonthlyReportView {
  month: string;
  /** calendar days counted: the 1st to min(month end, today) */
  days: number;
  items: MonthlyReportItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /me/attendance/receipt: what redeeming the scan receipt would record (the /punch one-tap confirmation). */
export interface ReceiptView {
  kiosk: { labels: LabelPair; site: { code: string; name: string } };
  scannedAt: string;
  /** Algiers "HH:MM" of the scan; for a duplicate, of the punch already recorded */
  localTime: string;
  workDate: string;
  receiptExpiresAt: string;
  /** the direction the punch would get (for a duplicate: the existing punch's) */
  direction: 'in' | 'out';
  /** redeeming returns an existing punch (second scan within the gap, same kiosk window) and records nothing */
  duplicate: boolean;
}
