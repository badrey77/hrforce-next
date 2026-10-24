/**
 * The month's computed payroll variables of one employment (docs/contracts/payroll-variables.md › Computation) — pure:
 * the engine hands in the employment, its leave requests and its attendance days (from the Leave and Attendance
 * modules), this file turns them into one value per computed source and the flags HR sees. No Nest, no Kysely.
 */
import { datesBetween, inclusiveDays, lastDayOf, maxDate, minDate, round2 } from './period.js';

export const PAYROLL_SOURCES = ['leave', 'absence', 'late', 'overtime_normal', 'overtime_rest_day', 'overtime_holiday', 'service_days', 'manual'] as const;
export type PayrollSource = (typeof PAYROLL_SOURCES)[number];
/** The sources HRForce computes (régularisations are recomputed for these). */
export type ComputedSource = Exclude<PayrollSource, 'manual'>;
export type PayrollUnit = 'days' | 'hours' | 'amount';

/** A computed value's key: the source, or `leave:<leave type id>`. */
export function sourceKey(source: PayrollSource, leaveTypeId: string | null): string {
  return source === 'leave' ? `leave:${leaveTypeId ?? ''}` : source;
}

export interface EmploymentSpan {
  hireDate: string;
  endDate: string | null;
}

export interface LeaveRequestFact {
  leaveTypeId: string;
  status: 'approved' | 'pending';
  startDate: string;
  endDate: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
}

/** One attendance day of the employment (Attendance's daily computation) and whether attendance was in use there. */
export interface AttendanceDayFact {
  date: string;
  status: string;
  /** the day is over (date < today) */
  final: boolean;
  lateMinutes: number;
  workedMinutes: number;
  scheduledMinutes: number;
  /** the employee's effective site that day had an active kiosk (assumption 6) */
  inUse: boolean;
}

/** Counts the days of a request inside [from, to] the way its type counts them (Leave's `leaveDaysWithin`). */
export type LeaveDayCounter = (request: LeaveRequestFact, from: string, to: string) => number;

export interface MonthInput {
  /** first day of the month */
  month: string;
  /** today in Algeria */
  today: string;
  employment: EmploymentSpan;
  /** approved and pending requests of the employment (any dates; filtered here) */
  leave: readonly LeaveRequestFact[];
  /** the attendance days of {@link attendanceWindow} (missing days are ignored) */
  days: readonly AttendanceDayFact[];
  overtimeMinMinutes: number;
  countLeaveDays: LeaveDayCounter;
}

export interface MonthResult {
  /** {@link sourceKey} → value (only non-zero values) */
  values: Map<string, number>;
  entry: string | null;
  exit: string | null;
  incompleteDays: number;
  pendingLeave: boolean;
  noAttendance: boolean;
}

/** The days of the month the employment covers, ignoring today: [max(1st, hire), min(last day, end)]; null if none. */
export function employmentWindow(month: string, e: EmploymentSpan): { from: string; to: string } | null {
  const from = maxDate(month, e.hireDate);
  const to = e.endDate === null ? lastDayOf(month) : minDate(lastDayOf(month), e.endDate);
  return from <= to ? { from, to } : null;
}

/** Employed days: the employment window, nothing after today. The attendance days the engine must compute. */
export function attendanceWindow(month: string, e: EmploymentSpan, today: string): { from: string; to: string } | null {
  const w = employmentWindow(month, e);
  if (!w) return null;
  const to = minDate(w.to, today);
  return w.from <= to ? { from: w.from, to } : null;
}

/** Every date of the {@link attendanceWindow} (empty when none). */
export function attendanceDates(month: string, e: EmploymentSpan, today: string): string[] {
  const w = attendanceWindow(month, e, today);
  return w ? datesBetween(w.from, w.to) : [];
}

const hours = (minutes: number): number => round2(minutes / 60);

export function computeMonth(input: MonthInput): MonthResult {
  const { month, employment: e } = input;
  const last = lastDayOf(month);
  const values = new Map<string, number>();
  const add = (key: string, value: number) => {
    const v = round2(value);
    if (v !== 0) values.set(key, v);
  };

  // leave: approved requests, the days inside the month and the employment (future approved days of the month count)
  const window = employmentWindow(month, e);
  const leaveByType = new Map<string, number>();
  if (window) {
    for (const r of input.leave) {
      if (r.status !== 'approved' || r.endDate < window.from || r.startDate > window.to) continue;
      leaveByType.set(r.leaveTypeId, (leaveByType.get(r.leaveTypeId) ?? 0) + input.countLeaveDays(r, window.from, window.to));
    }
  }
  for (const [type, days] of leaveByType) add(`leave:${type}`, days);

  // attendance: the employed days up to today; final days only
  const employed = attendanceWindow(month, e, input.today);
  const days = employed ? input.days.filter((d) => d.date >= employed.from && d.date <= employed.to) : [];
  let absent = 0;
  let late = 0;
  let overtime = 0;
  let restDay = 0;
  let holiday = 0;
  let incomplete = 0;
  for (const d of days) {
    if (!d.final) continue;
    if (d.status === 'incomplete') incomplete += 1;
    if (d.inUse && d.status === 'absent') absent += 1;
    if (d.inUse) late += d.lateMinutes;
    if (d.status === 'present' || d.status === 'late') {
      const extra = d.workedMinutes - d.scheduledMinutes;
      if (extra > 0 && extra >= input.overtimeMinMinutes) overtime += extra;
    } else if (d.status === 'rest_day') restDay += d.workedMinutes;
    else if (d.status === 'holiday') holiday += d.workedMinutes;
  }
  add('absence', absent);
  add('late', hours(late));
  add('overtime_normal', hours(overtime));
  add('overtime_rest_day', hours(restDay));
  add('overtime_holiday', hours(holiday));

  // entries and exits: calendar days employed in the month (a known end date counts), only for such a month
  const entry = e.hireDate >= month && e.hireDate <= last ? e.hireDate : null;
  const exit = e.endDate !== null && e.endDate >= month && e.endDate <= last ? e.endDate : null;
  if ((entry || exit) && window) add('service_days', inclusiveDays(window.from, window.to));

  return {
    values,
    entry,
    exit,
    incompleteDays: incomplete,
    pendingLeave: input.leave.some((r) => r.status === 'pending' && r.startDate <= last && r.endDate >= month),
    noAttendance: days.length > 0 && days.every((d) => !d.inUse),
  };
}

/** A kiosk's site and the Algerian days it was in use (inclusive; `to` null = still active). */
export interface KioskSpanFact {
  siteId: string;
  from: string;
  to: string | null;
}

/** Whether attendance is in use at `siteId` on `date` (assumption 6): an active kiosk paired on or before that day. */
export function attendanceInUse(spans: readonly KioskSpanFact[], siteId: string | null, date: string): boolean {
  if (siteId === null) return false;
  return spans.some((s) => s.siteId === siteId && s.from <= date && (s.to === null || date <= s.to));
}
