/**
 * Attendance (pointage) API types and pure helpers — from the binding contract `docs/contracts/attendance.md`
 * (Phase A: kiosks, punches, schedules, daily presence). Keep names exactly as written there: the API builds against
 * the same text. Plain TypeScript, no Angular: the types vanish at runtime and only let `strictTemplates` check our
 * usage; the helpers are unit-tested without TestBed.
 *
 * Lives in core/ because five features read it (kiosk, punch landing, Pointage, the HR board and settings, the
 * employee Présence tab) and shared/attendance/ renders parts of it.
 *
 * Times: every "HH:MM" the UI shows comes from the API's `localTime` (Africa/Algiers), never from the device's clock
 * or time zone (contract › Web). The only clock the web computes itself is the kiosk's display clock
 * (features/kiosk/kiosk-clock.ts), corrected against `serverTime`.
 */
import type { AppLanguage } from '../i18n/languages';
import type { EmployeeSiteRef, NamePair, UnitRef } from '../employees/employees.models';
import type { Labels } from '../leave/leave.models';

export type { Labels } from '../leave/leave.models';

// --- Day computation ----------------------------------------------------------------------------------------------

export type DayStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'incomplete'
  | 'expected'
  | 'on_leave'
  | 'holiday'
  | 'rest_day'
  | 'not_employed';

/** Statuses of the board (and of its counts): every status except `not_employed`, in the contract's order. */
export type BoardStatus = Exclude<DayStatus, 'not_employed'>;
export const BOARD_STATUSES: readonly BoardStatus[] = [
  'present',
  'late',
  'absent',
  'incomplete',
  'expected',
  'on_leave',
  'holiday',
  'rest_day',
];

export type DayFlag =
  | 'open'
  | 'early_departure'
  | 'half_day_leave_morning'
  | 'half_day_leave_afternoon'
  | 'leave_pending'
  | 'worked_on_rest_day'
  | 'worked_on_holiday'
  | 'worked_on_leave'
  | 'other_site'
  | 'unpaired_punch'
  | 'manual_punch'
  | 'corrected'
  | 'shared_device';

export interface UserRef {
  readonly id: string;
  readonly displayName: string;
}

export type SiteRef = EmployeeSiteRef;

/** The employee a day is about, as they were ON THAT DAY (unit, site). `id` = the employment id. */
export interface EmployeeRef {
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit: UnitRef;
  readonly site: SiteRef | null;
}

export interface PunchTime {
  readonly id: string;
  /** ISO UTC. */
  readonly occurredAt: string;
  /** "HH:MM", Algiers. */
  readonly localTime: string;
}

export type ScheduleSource = 'employment' | 'unit' | 'site' | 'company';

export interface DaySchedule {
  readonly scheduleId: string;
  readonly code: string;
  readonly labels: Labels;
  readonly source: ScheduleSource;
  readonly override: { readonly id: string; readonly labels: Labels; readonly approximate: boolean } | null;
  /** `null` on a rest day. */
  readonly start: string | null;
  readonly end: string | null;
  readonly breakStart: string | null;
  readonly breakEnd: string | null;
  /** After half days. */
  readonly expectedStart: string | null;
  readonly expectedEnd: string | null;
  readonly toleranceMinutes: number;
  readonly scheduledMinutes: number;
}

export type PunchDirection = 'in' | 'out';
export type PunchSource = 'qr' | 'manual' | 'correction';

export interface KioskLabels {
  readonly fr: string;
  readonly ar: string;
}

export interface PunchView {
  readonly id: string;
  readonly direction: PunchDirection;
  readonly occurredAt: string;
  readonly localTime: string;
  readonly workDate: string;
  readonly source: PunchSource;
  readonly kiosk: { readonly id: string; readonly labels: KioskLabels; readonly site: SiteRef } | null;
  readonly site: SiteRef | null;
  readonly reason: string | null;
  /** `null` for a QR punch (the employee themself). */
  readonly createdBy: UserRef | null;
  /** Phase B. */
  readonly correctionId: string | null;
  readonly status: 'live' | 'void';
  readonly void: {
    readonly at: string;
    readonly by: UserRef | null;
    readonly reason: string;
    readonly correctionId: string | null;
  } | null;
  /** Always `[]` on /me routes. */
  readonly _actions: readonly 'void'[];
}

export interface DayLeave {
  readonly requestId: string;
  readonly type: { readonly code: string; readonly labels: Labels };
  readonly part: 'full' | 'morning' | 'afternoon';
}

export interface AttendanceDayView {
  readonly date: string;
  readonly employee: EmployeeRef;
  readonly status: DayStatus;
  /** `date < today` (Algiers): the day will not change by itself any more. */
  readonly final: boolean;
  /** `null` when `not_employed`. */
  readonly schedule: DaySchedule | null;
  readonly arrival: PunchTime | null;
  readonly departure: PunchTime | null;
  readonly lateMinutes: number;
  readonly earlyDepartureMinutes: number;
  readonly workedMinutes: number;
  /** Sorted as the `DayFlag` union. */
  readonly flags: readonly DayFlag[];
  readonly leave: DayLeave | null;
  readonly holiday: { readonly labels: Labels; readonly approximate: boolean } | null;
  /** Per-employee routes only, oldest first, void included. */
  readonly punches?: readonly PunchView[];
}

export type Counts = Readonly<Record<BoardStatus, number>> & { readonly total: number };

export interface PresenceBoardView {
  readonly date: string;
  readonly final: boolean;
  /** When the API computed the board (ISO). */
  readonly asOf: string;
  /** Over every matching employee BEFORE the status filter. */
  readonly counts: Counts;
  readonly items: readonly AttendanceDayView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface TeamPresenceView extends PresenceBoardView {
  readonly units: readonly UnitRef[];
}

export interface DayTotals {
  readonly workedMinutes: number;
  readonly scheduledMinutes: number;
  readonly lateDays: number;
  readonly lateMinutes: number;
  readonly absentDays: number;
  readonly incompleteDays: number;
  readonly leaveDays: number;
  readonly earlyDepartureDays: number;
}

export interface MyDaysView {
  readonly from: string;
  readonly to: string;
  /** As of `to`. */
  readonly employee: EmployeeRef;
  /** With punches, oldest first. */
  readonly items: readonly AttendanceDayView[];
  readonly totals: DayTotals;
  /** The company policy (for the Law 18-07 notice: employees cannot read `GET /attendance/policy`). */
  readonly retentionMonths: number;
}

export interface EmployeeDaysView extends MyDaysView {
  /** `attendance.manage` over the employee, and not the caller's own employment. */
  readonly canManage: boolean;
}

export interface ScheduleSegment {
  readonly from: string;
  readonly to: string;
  readonly schedule: { readonly id: string; readonly code: string; readonly labels: Labels };
  readonly source: ScheduleSource;
  readonly sourceRef: { readonly kind: 'employment' | 'unit' | 'site'; readonly id: string; readonly code: string; readonly name: string } | null;
  readonly overrides: readonly { readonly id: string; readonly labels: Labels; readonly from: string; readonly to: string }[];
}

export interface ScheduleSegmentsView {
  readonly items: readonly ScheduleSegment[];
}

// --- Writes by HR -------------------------------------------------------------------------------------------------

/** `POST /employees/:id/attendance/punches` — Algiers local date and time. */
export interface ManualPunchInput {
  readonly direction: PunchDirection;
  readonly date: string;
  readonly time: string;
  readonly reason: string;
  readonly siteId?: string;
}

// --- Configuration ------------------------------------------------------------------------------------------------

export interface PolicyView {
  readonly retentionMonths: number;
  readonly minPunchGapSeconds: number;
}

export type PolicyInput = Partial<PolicyView>;

export const RETENTION_MIN = 12;
export const RETENTION_MAX = 120;
export const GAP_MIN = 0;
export const GAP_MAX = 600;
export const TOLERANCE_MAX = 60;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const OVERRIDE_MAX_DAYS = 60;

/** ISO weekday: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday. */
export type WeekdayNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WeekDay =
  | { readonly day: WeekdayNumber; readonly rest: true }
  | {
      readonly day: WeekdayNumber;
      readonly start: string;
      readonly end: string;
      readonly breakStart: string | null;
      readonly breakEnd: string | null;
    };

/** Exactly 7 entries, days 1..7 in order. */
export type Week = readonly WeekDay[];

export interface ScheduleVersion {
  readonly id: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly week: Week;
  readonly toleranceMinutes: number;
}

export interface ScheduleView {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
  readonly active: boolean;
  /** Newest first. */
  readonly versions: readonly ScheduleVersion[];
  readonly current: { readonly validFrom: string; readonly week: Week; readonly toleranceMinutes: number; readonly weeklyMinutes: number } | null;
  /** Current and future. */
  readonly assignmentCount: number;
}

export interface ScheduleList {
  readonly items: readonly ScheduleView[];
}

export interface NewSchedule {
  readonly code: string;
  readonly labels: Labels;
  readonly week: Week;
  readonly toleranceMinutes: number;
  readonly validFrom?: string;
}

export interface UpdateSchedule {
  readonly labels?: Labels;
  readonly active?: boolean;
}

export interface NewScheduleVersion {
  readonly validFrom: string;
  readonly week: Week;
  readonly toleranceMinutes: number;
}

export interface ScheduleBrief {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
}

export interface OverrideView {
  readonly id: string;
  /** `null` = every schedule of the company. */
  readonly schedule: ScheduleBrief | null;
  readonly labels: Labels;
  readonly from: string;
  /** Inclusive. */
  readonly to: string;
  readonly week: Week;
  readonly toleranceMinutes: number;
  readonly approximate: boolean;
}

export interface OverrideList {
  readonly items: readonly OverrideView[];
}

export interface OverrideInput {
  readonly scheduleId: string | null;
  readonly labels: Labels;
  readonly from: string;
  readonly to: string;
  readonly week: Week;
  readonly toleranceMinutes: number;
  readonly approximate: boolean;
}

export type AssignmentTargetKind = 'company' | 'site' | 'unit' | 'employment';
export const ASSIGNMENT_TARGET_KINDS: readonly AssignmentTargetKind[] = ['company', 'site', 'unit', 'employment'];

export interface AssignmentView {
  readonly id: string;
  readonly schedule: ScheduleBrief;
  readonly target: { readonly kind: AssignmentTargetKind; readonly id: string | null; readonly code: string | null; readonly name: string | null };
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly _actions: readonly ('end' | 'delete')[];
}

export interface AssignmentList {
  readonly items: readonly AssignmentView[];
}

export interface NewAssignment {
  readonly scheduleId: string;
  readonly target: { readonly kind: AssignmentTargetKind; readonly id: string | null };
  readonly validFrom: string;
}

export type KioskStatus = 'pending' | 'active' | 'revoked';

export interface KioskView {
  readonly id: string;
  readonly kind: 'qr_kiosk';
  readonly labels: KioskLabels;
  readonly site: SiteRef;
  readonly status: KioskStatus;
  readonly allowedNetworks: readonly string[];
  readonly pairedAt: string | null;
  /** An unused pairing code exists (its value is never shown again). */
  readonly pairing: { readonly expiresAt: string } | null;
  readonly lastSeen: { readonly at: string; readonly ip: string; readonly userAgent: string } | null;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
  readonly revoked: { readonly at: string; readonly by: UserRef | null; readonly reason: string } | null;
  readonly _actions: readonly ('update' | 'pair' | 'revoke')[];
}

export interface KioskList {
  readonly items: readonly KioskView[];
}

/** Shown ONCE: "K7M2-9QXA". */
export interface PairingCodeView {
  readonly code: string;
  readonly expiresAt: string;
}

export interface NewKiosk {
  readonly siteId: string;
  readonly labels: KioskLabels;
  readonly allowedNetworks?: readonly string[];
}

export interface UpdateKiosk {
  readonly labels?: KioskLabels;
  readonly siteId?: string;
  readonly allowedNetworks?: readonly string[];
}

export interface CreatedKiosk {
  readonly kiosk: KioskView;
  readonly pairing: PairingCodeView;
}

// --- Device side and phone ----------------------------------------------------------------------------------------

export interface KioskSessionView {
  readonly kiosk: { readonly id: string; readonly labels: KioskLabels; readonly site: { readonly code: string; readonly name: string } };
  readonly company: { readonly name: string };
  readonly serverTime: string;
  readonly windowSeconds: number;
}

export interface QrWindow {
  readonly window: number;
  /** The URL the code encodes: `${WEB_BASE_URL}/punch#<token>`. */
  readonly qr: string;
  readonly showFrom: string;
  readonly showUntil: string;
}

export interface KioskQrView {
  readonly serverTime: string;
  readonly windowSeconds: number;
  /** 4 entries: the current window and the next three. */
  readonly windows: readonly QrWindow[];
}

export interface ScanView {
  readonly kiosk: { readonly labels: KioskLabels; readonly site: { readonly code: string; readonly name: string } };
  readonly scannedAt: string;
  readonly localTime: string;
  readonly receiptExpiresAt: string;
}

export interface PunchResultView {
  readonly punch: PunchView;
  readonly duplicate: boolean;
  readonly day: AttendanceDayView;
}

// --- Board query (URL state) --------------------------------------------------------------------------------------

export type PresenceSort = 'unit' | 'name' | 'arrival' | 'status';
export const PRESENCE_SORTS: readonly PresenceSort[] = ['unit', 'name', 'arrival', 'status'];
export const PRESENCE_PAGE_SIZES: readonly number[] = [25, 50, 100];

/** The board's filters. `date: null` = today (the API's default, so the URL stays short). */
export interface PresenceQuery {
  readonly date: string | null;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly siteId: string | null;
  readonly status: BoardStatus | null;
  readonly q: string;
  readonly sort: PresenceSort;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_PRESENCE_QUERY: PresenceQuery = {
  date: null,
  unitId: null,
  includeSubUnits: true,
  siteId: null,
  status: null,
  q: '',
  sort: 'unit',
  page: 1,
  pageSize: 50,
};

// --- Pure helpers -------------------------------------------------------------------------------------------------

/** "1 h 05" (fr/en) / "1 س 05 د" (ar); under an hour "45 min" / "45 د". Negative values count as 0. */
export function formatMinutes(minutes: number, lang: AppLanguage): string {
  const total = Math.max(0, Math.floor(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (lang === 'ar') return h === 0 ? `${m} د` : `${h} س ${String(m).padStart(2, '0')} د`;
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** The kiosk label in the UI language: Arabic for `ar`, French otherwise (kiosks have no English label). */
export function kioskLabel(labels: KioskLabels, lang: AppLanguage): string {
  return lang === 'ar' ? labels.ar || labels.fr : labels.fr || labels.ar;
}

/** Crockford base32 alphabet (no I, L, O, U). */
const PAIRING_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A pairing code as typed → its 8 normalised characters, or `null` when it cannot be one (contract › Pairing:
 * case-insensitive, hyphens and spaces ignored, `O→0`, `I/L→1`). The API applies the same rules; normalising here
 * only lets the form say "8 characters" before sending.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return PAIRING_ALPHABET.test(code) ? code : null;
}

/** "K7M29QXA" → "K7M2-9QXA" (display only). */
export function formatPairingCode(code: string): string {
  const raw = code.replace(/-/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : code;
}

/** The retention for the Law 18-07 notice: whole years when it divides by 12, else months. */
export function retentionPeriod(months: number): { readonly unit: 'years' | 'months'; readonly count: number } {
  return months % 12 === 0 ? { unit: 'years', count: months / 12 } : { unit: 'months', count: months };
}

/** Today's date in Algiers (UTC+1, no daylight saving — contract › Time), whatever the device's time zone. */
export function algiersToday(now: number = Date.now()): string {
  return new Date(now + 3_600_000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` ± n days (calendar arithmetic in UTC: no DST surprises). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value);
}

/** `YYYY-MM` ± n months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/**
 * The `from`/`to` of a month view: the whole month, cut at `today` (the API refuses future days: 422 `future`).
 * `null` for a month that has not started.
 */
export function monthRange(month: string, today: string): { readonly from: string; readonly to: string } | null {
  const from = `${month}-01`;
  if (from > today) return null;
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  return { from, to: last < today ? last : today };
}

/** Sunday first for display (contract › Settings › Horaires), ISO numbers kept for the API. */
export const DISPLAY_WEEK: readonly WeekdayNumber[] = [7, 1, 2, 3, 4, 5, 6];

/** A date that falls on the ISO weekday (2026-01-05 is a Monday), for `DatePipe`'s 'EEEE'. */
export function weekdayDate(day: WeekdayNumber): string {
  return `2026-01-${String(4 + day).padStart(2, '0')}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** `end − start − break`, 0 on a rest day (contract › Week document). */
export function scheduledMinutesOf(day: WeekDay): number {
  if ('rest' in day) return 0;
  const breakMinutes = day.breakStart && day.breakEnd ? toMinutes(day.breakEnd) - toMinutes(day.breakStart) : 0;
  return Math.max(0, toMinutes(day.end) - toMinutes(day.start) - breakMinutes);
}

export function weeklyMinutesOf(week: Week): number {
  return week.reduce((sum, day) => sum + scheduledMinutesOf(day), 0);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value);
}

export type WeekErrorCode = 'invalid_time' | 'invalid_break' | 'no_working_day';

/** The API's week rules, checked before sending (the API answers 422 `week.<i>.<key>` with the same codes). */
export function weekErrors(week: Week): readonly { readonly field: string; readonly code: WeekErrorCode }[] {
  const errors: { field: string; code: WeekErrorCode }[] = [];
  week.forEach((day, i) => {
    if ('rest' in day) return;
    if (!isTimeOfDay(day.start) || !isTimeOfDay(day.end) || day.start >= day.end) {
      errors.push({ field: `week.${i}.end`, code: 'invalid_time' });
      return;
    }
    const hasStart = !!day.breakStart;
    const hasEnd = !!day.breakEnd;
    if (hasStart !== hasEnd) {
      errors.push({ field: `week.${i}.breakEnd`, code: 'invalid_break' });
      return;
    }
    if (day.breakStart && day.breakEnd) {
      const ok =
        isTimeOfDay(day.breakStart) &&
        isTimeOfDay(day.breakEnd) &&
        day.start < day.breakStart &&
        day.breakStart < day.breakEnd &&
        day.breakEnd < day.end;
      if (!ok) errors.push({ field: `week.${i}.breakEnd`, code: 'invalid_break' });
    }
  });
  if (!week.some((day) => !('rest' in day))) errors.push({ field: 'week', code: 'no_working_day' });
  return errors;
}

/** The contract's assumption 1: Sunday–Thursday 08:00–16:30, break 12:00–12:30, Friday and Saturday off. */
export function standardWeek(): Week {
  return ([1, 2, 3, 4, 5, 6, 7] as const).map((day): WeekDay =>
    day === 5 || day === 6 ? { day, rest: true } : { day, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30' },
  );
}

/** Colour family of a status chip (the text always names the status: never colour alone). */
export function statusTone(status: DayStatus): 'ok' | 'warn' | 'bad' | 'info' | 'off' {
  switch (status) {
    case 'present':
      return 'ok';
    case 'late':
    case 'incomplete':
      return 'warn';
    case 'absent':
      return 'bad';
    case 'expected':
      return 'info';
    default:
      return 'off';
  }
}
