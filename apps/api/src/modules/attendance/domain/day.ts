/**
 * The daily computation (docs/contracts/attendance.md › Daily computation) — pure, computed ON READ for each
 * (employment, date): nothing is stored, so late leave approvals, holiday edits, schedule changes and manual punches
 * show at once in every past day.
 *
 * Settled by the build: arrival / departure are compared with the schedule at MINUTE precision (the punch's Algiers
 * time truncated to the minute, as shown to people: 08:10:59 is "08:10", on time with a 10-minute tolerance);
 * worked time is summed at millisecond precision and floored to whole minutes.
 */
import { algiersMidnight, algiersMinuteOfDay } from './time.js';
import { isRestDay, type WeekDay } from './week.js';

export const DAY_STATUSES = ['present', 'late', 'absent', 'incomplete', 'expected', 'on_leave', 'holiday', 'rest_day', 'not_employed'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

/** In the contract's order (flags are returned sorted this way). */
export const DAY_FLAGS = [
  'open',
  'early_departure',
  'half_day_leave_morning',
  'half_day_leave_afternoon',
  'leave_pending',
  'worked_on_rest_day',
  'worked_on_holiday',
  'worked_on_leave',
  'other_site',
  'unpaired_punch',
  'manual_punch',
  'corrected',
  'shared_device',
] as const;
export type DayFlag = (typeof DAY_FLAGS)[number];

export type LeavePart = 'full' | 'morning' | 'afternoon';

export interface PunchFact {
  id: string;
  direction: 'in' | 'out';
  occurredAtMs: number;
  source: 'qr' | 'manual' | 'correction';
  status: 'live' | 'void';
  siteId: string | null;
  deviceRef: string | null;
  /** voided by an approved correction (Phase B: the `corrected` flag) */
  voidedByCorrection?: boolean;
}

export interface DayInput {
  date: string;
  /** the Algerian date of `nowMs` */
  today: string;
  nowMs: number;
  employed: boolean;
  /** the schedule's rule for the day (null: no schedule applies — treated as a rest day) */
  rule: { entry: WeekDay; toleranceMinutes: number } | null;
  /** the approved leave's part on this day, or null */
  leave: LeavePart | null;
  leavePending: boolean;
  holiday: boolean;
  /** live and void; any order */
  punches: readonly PunchFact[];
  /** the employee's effective site that day (other_site) */
  siteId: string | null;
  /** device refs used by a live QR punch of ANOTHER employment of the company that day */
  sharedRefs: ReadonlySet<string>;
  /** the caller holds attendance.manage over the employee (shared_device is shown only then) */
  showSharedDevice: boolean;
}

export interface DayResult {
  status: DayStatus;
  final: boolean;
  /** minutes since midnight after half days; null on non-working days */
  expectedStart: number | null;
  expectedEnd: number | null;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  flags: DayFlag[];
  arrivalId: string | null;
  departureId: string | null;
}

/**
 * The part of an approved request on `date`: `afternoon` off on its start date with half_day_start, `morning` off on
 * its end date with half_day_end (a one-day request with one flag is that half day), else `full`.
 */
export function leavePartOn(request: { startDate: string; endDate: string; halfDayStart: boolean; halfDayEnd: boolean }, date: string): LeavePart {
  if (request.startDate === request.endDate) {
    if (request.halfDayStart && !request.halfDayEnd) return 'afternoon';
    if (request.halfDayEnd && !request.halfDayStart) return 'morning';
    return 'full';
  }
  if (date === request.startDate && request.halfDayStart) return 'afternoon';
  if (date === request.endDate && request.halfDayEnd) return 'morning';
  return 'full';
}

function minutes(value: string | null): number | null {
  if (value === null) return null;
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

interface Pairs {
  arrival: PunchFact | null;
  departure: PunchFact | null;
  /** [inMs, outMs] */
  closed: [number, number][];
  open: boolean;
  unpaired: boolean;
}

/**
 * Walks the ordered live punches: an `in` opens a pair (an `in` while one is open is ignored for pairing and marks
 * `unpaired`), an `out` closes the open pair (an `out` with none open marks `unpaired`). arrival = the first `in`;
 * departure = the last `out` after the arrival.
 */
function pairsOf(live: readonly PunchFact[]): Pairs {
  const out: Pairs = { arrival: null, departure: null, closed: [], open: false, unpaired: false };
  let openAt: number | null = null;
  for (const p of live) {
    if (p.direction === 'in') {
      out.arrival ??= p;
      if (openAt !== null) out.unpaired = true;
      else openAt = p.occurredAtMs;
    } else {
      if (openAt === null) out.unpaired = true;
      else {
        out.closed.push([openAt, p.occurredAtMs]);
        openAt = null;
      }
      if (out.arrival && p.occurredAtMs >= out.arrival.occurredAtMs) out.departure = p;
    }
  }
  out.open = openAt !== null;
  return out;
}

function workedMs(closed: readonly [number, number][], breakWindow: [number, number] | null): number {
  let total = 0;
  for (const [a, b] of closed) {
    total += b - a;
    if (breakWindow) total -= Math.max(0, Math.min(b, breakWindow[1]) - Math.max(a, breakWindow[0]));
  }
  return Math.max(0, total);
}

export function computeDay(input: DayInput): DayResult {
  const final = input.date < input.today;
  const flags = new Set<DayFlag>();
  const base: DayResult = {
    status: 'not_employed',
    final,
    expectedStart: null,
    expectedEnd: null,
    scheduledMinutes: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    flags: [],
    arrivalId: null,
    departureId: null,
  };
  if (!input.employed) return base;

  const live = input.punches
    .filter((p) => p.status === 'live')
    .toSorted((a, b) => a.occurredAtMs - b.occurredAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pairs = pairsOf(live);
  if (pairs.unpaired) flags.add('unpaired_punch');
  if (input.leavePending) flags.add('leave_pending');
  if (live.some((p) => p.source === 'qr' && p.siteId !== null && p.siteId !== input.siteId)) flags.add('other_site');
  if (live.some((p) => p.source === 'manual')) flags.add('manual_punch');
  // Phase B: a live punch added by a correction, or a punch a correction voided
  if (input.punches.some((p) => (p.status === 'live' && p.source === 'correction') || (p.status === 'void' && p.voidedByCorrection === true))) flags.add('corrected');
  if (input.showSharedDevice && live.some((p) => p.source === 'qr' && p.deviceRef !== null && input.sharedRefs.has(p.deviceRef))) {
    flags.add('shared_device');
  }
  const result = (r: Partial<DayResult>): DayResult => ({
    ...base,
    arrivalId: pairs.arrival?.id ?? null,
    departureId: pairs.departure?.id ?? null,
    ...r,
    flags: DAY_FLAGS.filter((f) => flags.has(f)),
  });

  const entry = input.rule?.entry ?? null;
  const restDay = entry === null || isRestDay(entry);
  const nonWorking: DayStatus | null = input.leave === 'full' ? 'on_leave' : input.holiday ? 'holiday' : restDay ? 'rest_day' : null;
  if (nonWorking !== null) {
    if (live.length > 0) flags.add(nonWorking === 'on_leave' ? 'worked_on_leave' : nonWorking === 'holiday' ? 'worked_on_holiday' : 'worked_on_rest_day');
    if (pairs.open && !final) flags.add('open');
    return result({ status: nonWorking, workedMinutes: Math.floor(workedMs(pairs.closed, null) / 60_000) });
  }

  // a working day
  const day = entry as Exclude<WeekDay, { rest: true }>;
  const tolerance = input.rule?.toleranceMinutes ?? 0;
  const start = minutes(day.start) ?? 0;
  const end = minutes(day.end) ?? 0;
  const breakStart = minutes(day.breakStart);
  const breakEnd = minutes(day.breakEnd);
  const middle = Math.floor((start + end) / 2);
  let expectedStart = start;
  let expectedEnd = end;
  if (input.leave === 'morning') {
    expectedStart = breakEnd ?? middle;
    flags.add('half_day_leave_morning');
  } else if (input.leave === 'afternoon') {
    expectedEnd = breakStart ?? middle;
    flags.add('half_day_leave_afternoon');
  }
  const breakInside = breakStart !== null && breakEnd !== null ? Math.max(0, Math.min(expectedEnd, breakEnd) - Math.max(expectedStart, breakStart)) : 0;
  const scheduledMinutes = expectedEnd - expectedStart - breakInside;
  const midnight = algiersMidnight(input.date);
  const breakWindow: [number, number] | null =
    breakStart !== null && breakEnd !== null ? [midnight + breakStart * 60_000, midnight + breakEnd * 60_000] : null;
  const workedMinutes = Math.floor(workedMs(pairs.closed, breakWindow) / 60_000);
  const common = { expectedStart, expectedEnd, scheduledMinutes, workedMinutes };

  if (pairs.open && !final) flags.add('open');
  if (live.length === 0) {
    const beforeStart = input.date === input.today && algiersMinuteOfDay(input.nowMs) < expectedStart + tolerance;
    const future = input.date > input.today;
    return result({ ...common, status: final || !(beforeStart || future) ? 'absent' : 'expected' });
  }
  const arrival = pairs.arrival ? algiersMinuteOfDay(pairs.arrival.occurredAtMs) : null;
  const departure = pairs.departure ? algiersMinuteOfDay(pairs.departure.occurredAtMs) : null;
  const late = arrival !== null && arrival > expectedStart + tolerance;
  const lateMinutes = late && arrival !== null ? arrival - expectedStart : 0;
  let earlyDepartureMinutes = 0;
  if (departure !== null && departure < expectedEnd - tolerance && (final || !pairs.open)) {
    earlyDepartureMinutes = expectedEnd - departure;
    flags.add('early_departure');
  }
  const incomplete = arrival === null || (final && pairs.open);
  const status: DayStatus = incomplete ? 'incomplete' : late ? 'late' : 'present';
  return result({ ...common, status, lateMinutes, earlyDepartureMinutes });
}
