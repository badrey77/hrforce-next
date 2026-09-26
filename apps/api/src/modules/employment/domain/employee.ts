/**
 * Employment — pure rules (docs/contracts/employment.md). No Nest, no Kysely.
 * Dates are ISO `YYYY-MM-DD` strings (they compare correctly as strings and never shift with time zones).
 * Ranges are `[validFrom, validTo)` (`validTo` null = open), like org unit versions; an employment's `endDate` is
 * INCLUSIVE (last day worked), so closing an assignment / salary at the end sets `validTo = endDate + 1 day`.
 */

export const MATRICULE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
/** Numéro d'Identification National: 18 digits. */
export const NIN_PATTERN = /^[0-9]{18}$/;
/** Numéro de Sécurité Sociale: 10–15 digits. */
export const NSS_PATTERN = /^[0-9]{10,15}$/;
/** RIB (Algeria): exactly 20 digits. */
export const RIB_PATTERN = /^[0-9]{20}$/;
/** numeric(12,2): up to 10 integer digits, up to 2 decimals, written as a decimal STRING (never a JS float). */
export const MONEY_PATTERN = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
export const PERSON_NAME_MAX = 80;
export const JOB_TITLE_MAX = 120;

export const END_REASONS = ['resignation', 'retirement', 'dismissal', 'end_of_contract', 'death', 'other'] as const;
export type EndReason = (typeof END_REASONS)[number];

export type EmployeeStatus = 'active' | 'ended' | 'future';
export type StatusFilter = 'active' | 'ended' | 'all';
export type EmployeeSort = 'name' | 'matricule' | 'hireDate' | 'unit';

/** Field blocks guarded by their own permissions (omitted and listed in `_redacted` without them). */
export const FIELD_BLOCKS = ['salary', 'bank', 'nss'] as const;
export type FieldBlock = (typeof FIELD_BLOCKS)[number];

export type EmployeeAction = 'update' | 'assign' | 'end' | 'update_salary' | 'update_bank' | 'update_nss';

export type EmploymentProblemSlug =
  | 'matricule-taken'
  | 'nin-taken'
  | 'employment-open'
  | 'employment-ended'
  | 'hire-date'
  | 'assignment-date'
  | 'salary-date'
  | 'end-date';

/** A business-rule violation (→ 409 problem `urn:hrforce:problem:<slug>`, with `errors[{field}]` when tied to one). */
export class EmploymentRuleViolation extends Error {
  constructor(
    readonly slug: EmploymentProblemSlug,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'EmploymentRuleViolation';
  }
}

export interface Span {
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** `date` + `days` (calendar arithmetic in UTC, no time-zone shifts). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}

export function spanCovers(span: Span, date: string): boolean {
  return span.validFrom <= date && (span.validTo === null || date < span.validTo);
}

/** Oldest first. */
export function byStart<T extends Span>(spans: readonly T[]): T[] {
  return spans.toSorted((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}

/** Status as of `date`: future (hired after it), ended (last day before it), else active. */
export function statusOf(hireDate: string, endDate: string | null, date: string): EmployeeStatus {
  if (hireDate > date) return 'future';
  if (endDate !== null && endDate < date) return 'ended';
  return 'active';
}

/**
 * The assignment that decides an employee's scope, unit and site as of `date` (contract › Scope): the one valid on
 * `date`; else the latest one that started before it (an ended employment → its LAST assignment); else — an
 * employment that starts later — its first one. The list query applies the same ordering in SQL.
 */
export function scopeAssignment<T extends Span>(assignments: readonly T[], date: string): T | undefined {
  const sorted = byStart(assignments);
  return sorted.find((a) => spanCovers(a, date)) ?? sorted.filter((a) => a.validFrom <= date).at(-1) ?? sorted[0];
}

/** The date a (possibly past or future) span is shown "as of": `date` clamped into `[validFrom, validTo - 1]`. */
export function referenceDate(span: Span, date: string): string {
  if (date < span.validFrom) return span.validFrom;
  if (span.validTo !== null && date >= span.validTo) return addDays(span.validTo, -1);
  return date;
}

/** Writes on an employment whose end has been recorded are refused. */
export function assertOpen(endDate: string | null): void {
  if (endDate !== null) {
    throw new EmploymentRuleViolation('employment-ended', 'This employment has ended: it can no longer be changed.');
  }
}

/**
 * A new assignment from `validFrom`: strictly after the start of the latest assignment (which it closes the day
 * before, i.e. `validTo = validFrom`) and not before the hire date. Returns the assignment to close.
 */
export function planAssignment<T extends Span>(assignments: readonly T[], hireDate: string, validFrom: string): { close: T | undefined } {
  const latest = byStart(assignments).at(-1);
  if (validFrom < hireDate || (latest && validFrom <= latest.validFrom)) {
    const after = latest ? latest.validFrom : hireDate;
    throw new EmploymentRuleViolation(
      'assignment-date',
      `validFrom must be after ${after}, the start of the current assignment, and within the employment.`,
      'validFrom',
    );
  }
  return { close: latest };
}

/** A new salary version from `validFrom`: not before the hire date and strictly after the latest version's start. */
export function planSalary<T extends Span>(salaries: readonly T[], hireDate: string, validFrom: string): { close: T | undefined } {
  const latest = byStart(salaries).at(-1);
  if (validFrom < hireDate) {
    throw new EmploymentRuleViolation('salary-date', `validFrom must not be before the hire date ${hireDate}.`, 'validFrom');
  }
  if (latest && validFrom <= latest.validFrom) {
    throw new EmploymentRuleViolation('salary-date', `validFrom must be after ${latest.validFrom}, the start of the current salary.`, 'validFrom');
  }
  return { close: latest };
}

/**
 * Ending on `endDate` (inclusive): not before the hire date, the start of the current assignment or of the current
 * salary. Returns the open assignment / salary to close at `endDate + 1`.
 */
export function planEnd<A extends Span, S extends Span>(
  assignments: readonly A[],
  salaries: readonly S[],
  hireDate: string,
  endDate: string,
): { closeAssignment: A | undefined; closeSalary: S | undefined; validTo: string } {
  const assignment = byStart(assignments).at(-1);
  const salary = byStart(salaries).at(-1);
  const floor = [hireDate, assignment?.validFrom ?? hireDate, salary?.validFrom ?? hireDate].toSorted().at(-1) ?? hireDate;
  if (endDate < floor) {
    throw new EmploymentRuleViolation('end-date', `endDate must be on or after ${floor} (hire date / start of the current assignment or salary).`, 'endDate');
  }
  const validTo = addDays(endDate, 1);
  return {
    closeAssignment: assignment && (assignment.validTo === null || assignment.validTo > validTo) ? assignment : undefined,
    closeSalary: salary && (salary.validTo === null || salary.validTo > validTo) ? salary : undefined,
    validTo,
  };
}

/** A rehire starts after the person's previous employment ended (its end date is inclusive). */
export function assertRehireDate(previousEnd: string | null, hireDate: string): void {
  if (previousEnd !== null && hireDate <= previousEnd) {
    throw new EmploymentRuleViolation('hire-date', `hireDate must be after ${previousEnd}, the end of the previous employment.`, 'hireDate');
  }
}

/** A positive money amount written `123` / `123.4` / `123.45` (≤ 10 integer digits). */
export function isPositiveMoney(value: string): boolean {
  return MONEY_PATTERN.test(value) && /[1-9]/.test(value);
}

/**
 * `_actions` of an employee from the caller's permissions over its scope unit. Nothing on an employment whose end is
 * recorded (every write answers `employment-ended`).
 */
export function employeeActions(
  open: boolean,
  can: { update: boolean; salaryUpdate: boolean; bankUpdate: boolean; nssUpdate: boolean },
): EmployeeAction[] {
  if (!open) return [];
  const actions: EmployeeAction[] = [];
  if (can.update) actions.push('update', 'assign', 'end');
  if (can.salaryUpdate) actions.push('update_salary');
  if (can.bankUpdate) actions.push('update_bank');
  if (can.nssUpdate) actions.push('update_nss');
  return actions;
}
