/**
 * The day an employee is back at work after a leave (docs/contracts/documents.md › Snapshot: `resumptionText` of the
 * titre de congé). Pure: no Nest, no Kysely.
 *
 *  - Leave ending at noon (`halfDayEnd`): back the same day, in the afternoon.
 *  - Otherwise: the first day after `endDate` that is neither a weekend day (the leave policy's ISO weekdays) nor a
 *    public holiday — whatever the leave type's counting mode (a Friday return after a Thursday end is moved to the
 *    next working day).
 */
import { addDays, isoWeekday } from './dates.js';

export interface Resumption {
  date: string;
  /** back in the afternoon of `date` (the leave ended at noon) */
  afternoon: boolean;
}

/** At most this many days are scanned (a long run of holidays + weekends never gets near it). */
const MAX_SCAN = 60;

export function resumptionOf(input: { endDate: string; halfDayEnd: boolean; weekendDays: readonly number[]; holidays: readonly string[] }): Resumption {
  if (input.halfDayEnd) return { date: input.endDate, afternoon: true };
  const weekend = new Set(input.weekendDays);
  const holidays = new Set(input.holidays);
  let day = addDays(input.endDate, 1);
  for (let i = 0; i < MAX_SCAN && (weekend.has(isoWeekday(day)) || holidays.has(day)); i++) day = addDays(day, 1);
  return { date: day, afternoon: false };
}
