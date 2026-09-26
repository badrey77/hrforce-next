/**
 * Leave rules (docs/contracts/leave.md): request validation (409 problem slugs), cancellation, reference years,
 * balances and the oldest-year-first allocation of taken days. Pure domain code (no Nest, no Kysely).
 * Day amounts are handled in TENTHS (integers) internally so that sums never drift (numeric(5,1) in the database).
 */
import { addDays, addMonths } from './dates.js';

export type LeaveSlug =
  | 'leave-overlap'
  | 'leave-balance'
  | 'leave-max-request'
  | 'leave-once-per-career'
  | 'leave-dates'
  | 'leave-document-required'
  | 'leave-not-linked'
  | 'leave-not-cancellable'
  | 'leave-type-inactive'
  | 'leave-period';

/** A leave rule violation → 409 problem+json with this slug (and `errors[]` on `field` when given). */
export class LeaveRuleViolation extends Error {
  constructor(
    readonly slug: LeaveSlug,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export const toTenths = (days: number | string): number => Math.round(Number(days) * 10);
export const fromTenths = (tenths: number): number => tenths / 10;

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

// ── reference years ───────────────────────────────────────────────────────────────────────────────────────────────

/** First day of the reference year that contains `date` (policy `reference_start_month`, e.g. 7 → 1 July). */
export function periodStartOf(date: string, startMonth: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
}

/** Last day of the reference year starting on `periodStart`. */
export function periodEndOf(periodStart: string): string {
  return addDays(addMonths(periodStart, 12), -1);
}

/** A valid reference-year start for the policy (first day of the start month). */
export function isPeriodStart(date: string, startMonth: number): boolean {
  return date.endsWith('-01') && Number(date.slice(5, 7)) === startMonth;
}

/**
 * When the days of a reference year become usable: for accrued types (annual leave) `delayMonths` after the year
 * starts (Law 90-11: earned 1 July N-1 → 30 June N, taken from 1 July N); for other balance types (recovery, fed by
 * HR adjustments) immediately.
 */
export function availableFromOf(periodStart: string, accrued: boolean, delayMonths: number): string {
  return accrued ? addMonths(periodStart, delayMonths) : periodStart;
}

// ── balances ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerSums {
  periodStart: string;
  /** tenths per kind */
  accrual: number;
  taken: number;
  adjustment: number;
  reversal: number;
}

export interface PeriodBalance {
  periodStart: string;
  periodEnd: string;
  availableFrom: string;
  accrued: number;
  taken: number;
  adjusted: number;
  /** ledger sum (tenths) */
  balance: number;
}

export function periodBalances(sums: readonly LedgerSums[], accrued: boolean, delayMonths: number): PeriodBalance[] {
  return sums
    .map((s) => ({
      periodStart: s.periodStart,
      periodEnd: periodEndOf(s.periodStart),
      availableFrom: availableFromOf(s.periodStart, accrued, delayMonths),
      accrued: s.accrual,
      // reversals give back what was taken
      taken: s.taken + s.reversal,
      adjusted: s.adjustment,
      balance: s.accrual + s.taken + s.adjustment + s.reversal,
    }))
    .toSorted((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
}

/** Days (tenths) usable for leave starting on `date`: the balances of the years already available on that date. */
export function availableOn(periods: readonly PeriodBalance[], date: string): number {
  return periods.filter((p) => p.availableFrom <= date).reduce((sum, p) => sum + p.balance, 0);
}

export interface Allocation {
  periodStart: string;
  /** tenths (positive) */
  days: number;
}

/**
 * Taken days (tenths) against the OLDEST available reference years with remaining days first. Returns null when the
 * available years do not hold enough.
 */
export function allocateTaken(periods: readonly PeriodBalance[], date: string, days: number): Allocation[] | null {
  let rest = days;
  const allocations: Allocation[] = [];
  for (const period of periods) {
    if (rest <= 0) break;
    if (period.availableFrom > date || period.balance <= 0) continue;
    const take = Math.min(rest, period.balance);
    allocations.push({ periodStart: period.periodStart, days: take });
    rest -= take;
  }
  return rest > 0 ? null : allocations;
}

// ── request validation ────────────────────────────────────────────────────────────────────────────────────────────

export interface TypeRules {
  active: boolean;
  hasBalance: boolean;
  maxDaysPerRequest: number | null;
  oncePerCareer: boolean;
  requiresDocument: boolean;
}

export interface RequestFacts {
  startDate: string;
  endDate: string;
  /** requested days (tenths) */
  days: number;
  documentRef: string | null;
  employment: { hireDate: string; endDate: string | null };
  /** another pending/approved request of the employment intersects [start, end] */
  overlaps: boolean;
  /** a pending/approved request of this type already exists for the person (once-per-career types) */
  alreadyTaken: boolean;
  /** usable balance on the start date minus the other pending requests of the type (tenths); null = no balance */
  available: number | null;
}

/** The first violated rule, in a stable order (dates, document, max, once per career, overlap, balance). */
export function checkRequest(type: TypeRules, facts: RequestFacts): void {
  if (!type.active) throw new LeaveRuleViolation('leave-type-inactive', 'This leave type is not available.', 'leaveTypeId');
  if (facts.endDate < facts.startDate) throw new LeaveRuleViolation('leave-dates', 'The end date is before the start date.', 'endDate');
  if (facts.startDate < facts.employment.hireDate) {
    throw new LeaveRuleViolation('leave-dates', `The leave starts before the hire date ${facts.employment.hireDate}.`, 'startDate');
  }
  if (facts.employment.endDate !== null && facts.endDate > facts.employment.endDate) {
    throw new LeaveRuleViolation('leave-dates', `The leave ends after the last day of the employment ${facts.employment.endDate}.`, 'endDate');
  }
  if (type.requiresDocument && !facts.documentRef) {
    throw new LeaveRuleViolation('leave-document-required', 'This leave type requires a supporting document reference.', 'documentRef');
  }
  if (type.maxDaysPerRequest !== null && facts.days > type.maxDaysPerRequest) {
    throw new LeaveRuleViolation('leave-max-request', `At most ${fromTenths(type.maxDaysPerRequest)} days per request for this type.`, 'endDate');
  }
  if (type.oncePerCareer && facts.alreadyTaken) {
    throw new LeaveRuleViolation('leave-once-per-career', 'This leave can only be taken once per career.', 'leaveTypeId');
  }
  if (facts.overlaps) throw new LeaveRuleViolation('leave-overlap', 'Another pending or approved request covers some of these days.', 'startDate');
  if (type.hasBalance && facts.available !== null && facts.days > facts.available) {
    throw new LeaveRuleViolation('leave-balance', `Only ${fromTenths(Math.max(0, facts.available))} days are available (pending requests included).`, 'endDate');
  }
}

/** The requester may cancel a pending request, or an approved one that has not started yet (start > today). */
export function canCancel(status: RequestStatus, startDate: string, today: string): boolean {
  return status === 'pending' || (status === 'approved' && startDate > today);
}

// ── policy ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Weekend days: distinct ISO weekday numbers, at most 3. */
export function isWeekendSet(days: readonly number[]): boolean {
  return days.length <= 3 && new Set(days).size === days.length && days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}
