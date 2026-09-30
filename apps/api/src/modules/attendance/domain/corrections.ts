/**
 * Punch correction requests (docs/contracts/attendance.md › Phase B › Rules) — pure, no Nest, no Kysely.
 *
 * An employee asks, for ONE work day, for 1–4 changes: `add` a punch (direction + Algiers time) or `void` one of that
 * day's live punches. Approval (through the workflow engine) inserts `source='correction'` punches and voids the targets;
 * punches are never edited in place.
 */
import { addDays, algiersInstant, parseHhMm } from './time.js';

export const CORRECTION_MIN_CHANGES = 1;
export const CORRECTION_MAX_CHANGES = 4;

export type ChangeInput = { action: 'add'; direction: 'in' | 'out'; time: string } | { action: 'void'; punchId: string };

export interface CorrectionFieldError {
  field: string;
  code: string;
  message: string;
}

export interface CorrectionRequestFacts {
  date: string;
  /** the Algerian date of `nowMs` */
  today: string;
  nowMs: number;
  maxAgeDays: number;
  employment: { hireDate: string; endDate: string | null };
  changes: readonly ChangeInput[];
  /** every punch of the caller's employment on `date` (live and void) */
  dayPunches: readonly { id: string; status: 'live' | 'void'; occurredAtMs: number }[];
}

export interface CheckedChange {
  position: number;
  action: 'add' | 'void';
  direction: 'in' | 'out' | null;
  occurredAtMs: number | null;
  punchId: string | null;
}

export type CorrectionCheck =
  | { ok: true; changes: CheckedChange[] }
  /** 409 attendance-correction-date: before the window, in the future, or outside the employment */
  | { ok: false; kind: 'date' }
  /** 422 with errors[] */
  | { ok: false; kind: 'invalid'; errors: CorrectionFieldError[] };

const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/**
 * The request checks in the contract's order (after `attendance-not-linked`, before `attendance-correction-pending`):
 * 1. the day: ≤ today, ≥ today − maxAgeDays, inside the employment → else `date`;
 * 2. 1–4 changes → `changes` `min_items` / `max_items`;
 * 3. per change: an `add` not in the future (`changes.<i>.time` `future`), not at the minute of a live punch that the
 *    request does not void (`exists`) nor of another `add` (`duplicate`); a `void` of a LIVE punch of that day
 *    (`changes.<i>.punchId` `not_found` — a void punch, another day's or another person's is not found), each at most
 *    once (`duplicate`).
 */
export function checkCorrectionRequest(f: CorrectionRequestFacts): CorrectionCheck {
  const earliest = addDays(f.today, -f.maxAgeDays);
  const employed = f.employment.hireDate <= f.date && (f.employment.endDate === null || f.date <= f.employment.endDate);
  if (f.date > f.today || f.date < earliest || !employed) return { ok: false, kind: 'date' };
  if (f.changes.length < CORRECTION_MIN_CHANGES) {
    return { ok: false, kind: 'invalid', errors: [{ field: 'changes', code: 'min_items', message: `At least ${CORRECTION_MIN_CHANGES} change.` }] };
  }
  if (f.changes.length > CORRECTION_MAX_CHANGES) {
    return { ok: false, kind: 'invalid', errors: [{ field: 'changes', code: 'max_items', message: `At most ${CORRECTION_MAX_CHANGES} changes.` }] };
  }
  const errors: CorrectionFieldError[] = [];
  const live = new Map(f.dayPunches.filter((p) => p.status === 'live').map((p) => [p.id, p]));
  const voided = new Set(f.changes.flatMap((c) => (c.action === 'void' ? [c.punchId.toLowerCase()] : [])));
  const seenTargets = new Set<string>();
  const seenMinutes = new Set<number>();
  const changes: CheckedChange[] = [];
  f.changes.forEach((c, position) => {
    if (c.action === 'add') {
      const minutes = parseHhMm(c.time);
      if (minutes === null) {
        errors.push({ field: `changes.${position}.time`, code: 'invalid', message: 'HH:MM, 00:00–23:59.' });
        return;
      }
      const at = algiersInstant(f.date, minutes);
      if (at > f.nowMs) errors.push({ field: `changes.${position}.time`, code: 'future', message: 'Not in the future.' });
      else if ([...live.values()].some((p) => !voided.has(p.id) && minuteOf(p.occurredAtMs) === minuteOf(at))) {
        errors.push({ field: `changes.${position}.time`, code: 'exists', message: 'A punch already exists at this minute.' });
      } else if (seenMinutes.has(minuteOf(at))) errors.push({ field: `changes.${position}.time`, code: 'duplicate', message: 'Twice the same minute.' });
      seenMinutes.add(minuteOf(at));
      changes.push({ position, action: 'add', direction: c.direction, occurredAtMs: at, punchId: null });
      return;
    }
    const id = c.punchId.toLowerCase();
    if (!live.has(id)) errors.push({ field: `changes.${position}.punchId`, code: 'not_found', message: 'Not a live punch of this day.' });
    else if (seenTargets.has(id)) errors.push({ field: `changes.${position}.punchId`, code: 'duplicate', message: 'This punch is already in the request.' });
    seenTargets.add(id);
    changes.push({ position, action: 'void', direction: null, occurredAtMs: null, punchId: id });
  });
  if (errors.length > 0) return { ok: false, kind: 'invalid', errors };
  return { ok: true, changes };
}
