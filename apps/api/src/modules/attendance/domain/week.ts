/**
 * The week document of schedules and overrides (docs/contracts/attendance.md › Week document) — pure rules.
 * Exactly 7 entries, ISO days 1..7 in order; a day is either `{day, rest: true}` or a working day
 * `{day, start, end, breakStart, breakEnd}` ("HH:MM"; the break is both or neither).
 */
import { parseHhMm } from './time.js';

export type IsoDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface RestDay {
  day: IsoDay;
  rest: true;
}

export interface WorkDay {
  day: IsoDay;
  start: string;
  end: string;
  breakStart: string | null;
  breakEnd: string | null;
}

export type WeekDay = RestDay | WorkDay;
export type Week = WeekDay[];

export interface WeekError {
  field: string;
  code: 'invalid' | 'invalid_time' | 'invalid_break' | 'no_working_day';
  message: string;
}

export function isRestDay(day: WeekDay): day is RestDay {
  return 'rest' in day && day.rest === true;
}

/** Minutes of a working day: end − start − the break. */
export function scheduledMinutesOf(day: WeekDay): number {
  if (isRestDay(day)) return 0;
  const start = parseHhMm(day.start) ?? 0;
  const end = parseHhMm(day.end) ?? 0;
  const bs = day.breakStart === null ? null : parseHhMm(day.breakStart);
  const be = day.breakEnd === null ? null : parseHhMm(day.breakEnd);
  return end - start - (bs !== null && be !== null ? be - bs : 0);
}

export function weeklyMinutesOf(week: readonly WeekDay[]): number {
  return week.reduce((sum, d) => sum + scheduledMinutesOf(d), 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an untrusted week (request body) → the canonical week, or the contract's field errors
 * (`week.<i>.<key>` with `invalid_time` / `invalid_break`, `week` with `no_working_day` or `invalid`).
 */
export function validateWeek(raw: unknown): { ok: true; week: Week } | { ok: false; errors: WeekError[] } {
  if (!Array.isArray(raw) || raw.length !== 7) {
    return { ok: false, errors: [{ field: 'week', code: 'invalid', message: 'Exactly 7 days, Monday (1) to Sunday (7).' }] };
  }
  const errors: WeekError[] = [];
  const week: Week = [];
  raw.forEach((entry: unknown, i) => {
    const day = (i + 1) as IsoDay;
    if (!isObject(entry) || entry['day'] !== day) {
      errors.push({ field: `week.${i}.day`, code: 'invalid', message: `Entry ${i} must be day ${day}.` });
      return;
    }
    if (entry['rest'] === true) {
      week.push({ day, rest: true });
      return;
    }
    const start = parseHhMm(entry['start']);
    const end = parseHhMm(entry['end']);
    if (start === null) errors.push({ field: `week.${i}.start`, code: 'invalid_time', message: 'HH:MM, 00:00–23:59.' });
    if (end === null) errors.push({ field: `week.${i}.end`, code: 'invalid_time', message: 'HH:MM, 00:00–23:59.' });
    if (start !== null && end !== null && start >= end) errors.push({ field: `week.${i}.end`, code: 'invalid_time', message: 'The end must be after the start.' });
    const rawBs = entry['breakStart'] ?? null;
    const rawBe = entry['breakEnd'] ?? null;
    const bs = rawBs === null ? null : parseHhMm(rawBs);
    const be = rawBe === null ? null : parseHhMm(rawBe);
    if (rawBs !== null && bs === null) errors.push({ field: `week.${i}.breakStart`, code: 'invalid_time', message: 'HH:MM, 00:00–23:59.' });
    if (rawBe !== null && be === null) errors.push({ field: `week.${i}.breakEnd`, code: 'invalid_time', message: 'HH:MM, 00:00–23:59.' });
    if ((rawBs === null) !== (rawBe === null)) {
      errors.push({ field: `week.${i}.${rawBs === null ? 'breakStart' : 'breakEnd'}`, code: 'invalid_break', message: 'Give both break times or neither.' });
    } else if (bs !== null && be !== null && start !== null && end !== null && start < end && !(start < bs && bs < be && be < end)) {
      errors.push({ field: `week.${i}.breakStart`, code: 'invalid_break', message: 'The break must lie inside the working hours (start < break start < break end < end).' });
    }
    week.push({
      day,
      start: typeof entry['start'] === 'string' ? entry['start'] : '',
      end: typeof entry['end'] === 'string' ? entry['end'] : '',
      breakStart: typeof rawBs === 'string' ? rawBs : null,
      breakEnd: typeof rawBe === 'string' ? rawBe : null,
    });
  });
  if (errors.length === 0 && week.every(isRestDay)) {
    errors.push({ field: 'week', code: 'no_working_day', message: 'At least one working day.' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, week };
}

/** A stored week (trusted JSON from the database) → typed week. */
export function storedWeek(raw: unknown): Week {
  return Array.isArray(raw) ? (raw as Week) : [];
}

/** The standard week of assumption 1: Sunday–Thursday 08:00–16:30, break 12:00–12:30; Friday + Saturday rest. */
export const STANDARD_WEEK: Week = [1, 2, 3, 4, 5, 6, 7].map((d) =>
  d === 5 || d === 6
    ? { day: d as IsoDay, rest: true as const }
    : { day: d as IsoDay, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30' },
);
