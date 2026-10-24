/** Validators, error keys and helpers shared by the payroll settings forms (docs/contracts/payroll-variables.md). */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { allowedColumns, MAX_COLUMNS, type PayrollLayout } from '../../core/payroll/payroll.models';

export const PAYROLL_ERROR_KEYS: Readonly<Record<string, string>> = {
  required: 'payroll.settings.errors.required',
  maxlength: 'payroll.settings.errors.tooLong',
  range: 'payroll.settings.errors.range',
  pattern: 'payroll.settings.errors.code',
};

export const PAYROLL_SLUGS: SlugTable = {
  'payroll-code-taken': { key: 'payroll.settings.errors.codeTaken', field: 'exportCode' },
  'forbidden-scope': { key: 'payroll.settings.errors.companyWide' },
};

/** Required text of at most `max` characters once trimmed. */
export function requiredText(max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const length = typeof control.value === 'string' ? control.value.trim().length : 0;
    if (length === 0) return { required: true };
    if (length > max) return { maxlength: { requiredLength: max } };
    return null;
  };
}

/** A whole number within [min, max], as one error carrying both bounds (the message names the range). */
export function wholeNumberBetween(min: number, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw: unknown = control.value;
    if (raw === null || raw === '' || raw === undefined) return { required: true };
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? null : { range: { min, max } };
  };
}

/**
 * The columns kept when the layout changes: those the layout allows, in their order, plus the required ones it lacks
 * (`matricule` first; `rubrique` and `value` appended for `per_line`), at most `MAX_COLUMNS`.
 */
export function normalizeColumns(layout: PayrollLayout, columns: readonly string[]): string[] {
  const allowed = allowedColumns(layout);
  const kept = [...new Set(columns)].filter((c) => allowed.includes(c));
  if (!kept.includes('matricule')) kept.unshift('matricule');
  if (layout === 'per_line') {
    for (const required of ['rubrique', 'value']) if (!kept.includes(required)) kept.push(required);
  }
  return kept.slice(0, MAX_COLUMNS);
}

/** Moves `columns[index]` by `delta` (−1 up, +1 down); out of range → unchanged copy. */
export function moveColumn(columns: readonly string[], index: number, delta: -1 | 1): string[] {
  const next = [...columns];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

/**
 * Server errors of the settings forms: field errors on controls, the `columns` rule (not a control) reported through
 * `columnsError`, the rest as a form-level message.
 */
export function settingsProblemToForm(form: FormGroup, error: unknown, columnsError?: (key: string) => void): FormMessage | null {
  if (columnsError && isApiProblemError(error) && error.problem.errors?.some((e) => e.field === 'columns')) {
    columnsError('payroll.settings.format.columnsProblem.invalid');
    const rest = error.problem.errors.filter((e) => e.field !== 'columns');
    if (rest.length === 0) return null;
  }
  return problemToForm(form, error, PAYROLL_SLUGS);
}
