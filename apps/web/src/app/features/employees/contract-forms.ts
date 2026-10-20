/**
 * Contract form rules (docs/contracts/contracts-deadlines.md › Contracts): fixed-term types need an end date, a CDI
 * has none; the end is not before the start; probation ends between the start and 12 months after it. Shared by the
 * contract block of the create / rehire / hire forms and the « Contrats » tab.
 */
import { type AbstractControl, type FormControl, type FormGroup, type NonNullableFormBuilder, type ValidationErrors, type ValidatorFn, Validators } from '@angular/forms';
import {
  CONTRACT_REASON_MAX,
  CONTRACT_REFERENCE_MAX,
  type ContractType,
  type InitialContract,
  isFixedTerm,
  PROBATION_MAX_MONTHS,
} from '../../core/contracts/contracts.models';
import { isIsoDate } from '../../core/date/iso-date';
import type { SlugTable } from '../../core/http/problem-form';
import { isoDate, notBefore } from './employee-forms';

/** `iso` + `months` calendar months (the day is kept; 2025-01-31 + 1 → 2025-03-03, as `Date` rolls it). */
export function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/**
 * The last allowed probation end for a contract starting on `start` (and ending on `end`, when fixed-term): the day
 * before `start` + 12 months, never after the contract's end — the API's rule (2026-03-01 → 2027-02-28).
 */
export function probationLimit(start: string, end?: string | null): string {
  const limit = new Date(`${addMonths(start, PROBATION_MAX_MONTHS)}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - 1);
  const max = limit.toISOString().slice(0, 10);
  return isIsoDate(end) && end >= start && end < max ? end : max;
}

/** The contract type of the control's group (the sibling `contractType` control). */
function typeOf(control: AbstractControl): ContractType | '' {
  const value: unknown = control.parent?.get('contractType')?.value;
  return typeof value === 'string' ? (value as ContractType | '') : '';
}

/** `endDate`: required for a fixed-term type (a CDI has no end, its field is hidden and left empty). */
export const endDateForType: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  isFixedTerm(typeOf(control)) && !control.value ? { required: true } : null;

/**
 * `probationEnd`: between `start()` and the day before 12 months after it, within the contract (the sibling
 * `endDate` control, when the group has one and it is filled).
 */
export function probationWithin(start: () => string | null): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    const from = start();
    if (!isIsoDate(value) || !isIsoDate(from)) return null;
    const end: unknown = control.parent?.get('endDate')?.value;
    const limit = probationLimit(from, typeof end === 'string' ? end : null);
    return value < from || value > limit ? { probationRange: { from, to: limit } } : null;
  };
}

export type ContractTypeControl = FormControl<ContractType | ''>;

export type ContractFormGroup = FormGroup<{
  contractType: ContractTypeControl;
  endDate: FormControl<string>;
  probationEnd: FormControl<string>;
  reference: FormControl<string>;
  reason: FormControl<string>;
}>;

/** The `contract` block of the create / rehire / hire forms; `start()` is the hire date. */
export function contractFormGroup(fb: NonNullableFormBuilder, start: () => string | null): ContractFormGroup {
  const group: ContractFormGroup = fb.group({
    contractType: fb.control<ContractType | ''>('', Validators.required),
    endDate: ['', [isoDate, endDateForType, notBefore(start)]],
    probationEnd: ['', [isoDate, notBefore(start), probationWithin(start)]],
    reference: ['', Validators.maxLength(CONTRACT_REFERENCE_MAX)],
    reason: ['', Validators.maxLength(CONTRACT_REASON_MAX)],
  });
  // A CDI has no end date: clear it, and re-check the end date's "required" when the type changes.
  group.controls.contractType.valueChanges.subscribe((type) => {
    const { endDate } = group.controls;
    if (!isFixedTerm(type) && endDate.value) endDate.setValue('');
    endDate.updateValueAndValidity();
  });
  group.controls.endDate.valueChanges.subscribe(() => group.controls.probationEnd.updateValueAndValidity());
  return group;
}

/** Re-runs the date rules after the start (the hire date) changed. */
export function revalidateDates(group: ContractFormGroup): void {
  group.controls.endDate.updateValueAndValidity();
  group.controls.probationEnd.updateValueAndValidity();
}

/** The block's value as the API's `contract` (blanks left out; the end date only for a fixed-term type). */
export function initialContractBody(group: ContractFormGroup, options: { readonly withTexts: boolean } = { withTexts: true }): InitialContract | undefined {
  const { contractType, endDate, probationEnd, reference, reason } = group.getRawValue();
  if (contractType === '') return undefined;
  const body: { -readonly [K in keyof InitialContract]: InitialContract[K] } = { contractType };
  if (isFixedTerm(contractType) && endDate) body.endDate = endDate;
  if (probationEnd) body.probationEnd = probationEnd;
  if (options.withTexts && reference.trim()) body.reference = reference.trim();
  if (options.withTexts && reason.trim()) body.reason = reason.trim();
  return body;
}

/**
 * Translated messages of the contract rules' 422 codes (the API's `message` is English): the rules the form cannot
 * check itself (a renewal follows the previous contract, the initial one starts on the hire date…).
 */
export const CONTRACT_CODE_KEYS: Readonly<Record<string, string>> = {
  must_follow_previous: 'contracts.problems.mustFollowPrevious',
  must_match_previous: 'contracts.problems.mustMatchPrevious',
  must_equal_hire_date: 'contracts.problems.mustEqualHireDate',
  after_employment_end: 'contracts.problems.afterEmploymentEnd',
  out_of_range: 'contracts.problems.probationOutOfRange',
  before_start: 'contracts.problems.endBeforeStart',
  not_allowed: 'contracts.problems.endNotAllowed',
  required: 'employees.form.errors.required',
};

/** `POST /employees/:id/contracts` and `PATCH …/:contractId`. */
export const CONTRACT_SLUGS: SlugTable = {
  'contract-overlap': { key: 'contracts.problems.overlap', field: 'startDate' },
  'contract-not-latest': { key: 'contracts.problems.notLatest' },
  'contract-not-fixed-term': { key: 'contracts.problems.renewNotFixedTerm', field: 'kind' },
  'contract-initial-exists': { key: 'contracts.problems.initialExists', field: 'kind' },
  'contract-initial-missing': { key: 'contracts.problems.initialMissing', field: 'kind' },
  'contract-changed': { key: 'contracts.problems.changed' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};

/** `POST …/:contractId/decision`. */
export const DECISION_SLUGS: SlugTable = {
  'contract-decision-pending': { key: 'contracts.problems.decisionPending' },
  'contract-not-fixed-term': { key: 'contracts.problems.notFixedTerm' },
  'contract-not-latest': { key: 'contracts.problems.decisionNotLatest' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};
