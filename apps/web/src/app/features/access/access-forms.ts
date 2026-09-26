/**
 * Form helpers of the Access feature: validators, the 409 slug tables, and grant dates.
 *
 * Angular concepts:
 * - **A cross-field validator on the GROUP** (`validToNotBeforeFrom`): "to ≥ from" needs two values, so it sits on
 *   the FormGroup (second argument of `fb.group(…, { validators })`) and reports `{ dateOrder: true }` on the group,
 *   not on either control. The template shows it next to "to". See docs/angular/07-forms.md › Cross-field validators.
 * - **A validator that reads a signal** (`dateWithin(bounds)`): the end-grant dialog's limits depend on WHICH grant
 *   is being ended. The validator receives a getter and reads it every time it runs, so one control serves every
 *   grant — no `setValidators()` juggling. Reading a signal inside a validator does NOT make it reactive (validators
 *   run on value changes, not on signal changes); the dialog therefore sets the grant first, then resets the
 *   control's value, which re-runs validation.
 * - `ValidatorFn` returns `null` for "no error" and leaves an empty value to `Validators.required` — one message at
 *   a time (same choice as org-forms.ts).
 */
import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import type { SlugTable } from '../../core/http/problem-form';
import type { GrantView } from '../../core/access/access.models';

/** Contract: role codes are unique per company, "same pattern as unit codes"; seeded codes are lower-case. */
export const ROLE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
export const ROLE_NAME_MAX = 120;

/** Fails with `{ isoDate: true }` unless empty (left to `required`) or a real `YYYY-MM-DD` date. */
export const isoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  !control.value || isIsoDate(control.value) ? null : { isoDate: true };

/** Fails with `{ required: true }` for a whitespace-only string. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/** For a `FormControl<string[]>`: at least one item. */
export const atLeastOne: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  Array.isArray(control.value) && control.value.length > 0 ? null : { required: true };

/** Group validator: `validTo`, when set, is on or after `validFrom` (ISO strings compare like dates). */
export const validToNotBeforeFrom: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const from: unknown = group.get('validFrom')?.value;
  const to: unknown = group.get('validTo')?.value;
  if (!isIsoDate(from) || !isIsoDate(to)) return null; // empty/invalid: left to the controls' own validators
  return to >= from ? null : { dateOrder: true };
};

/** Control validator: the date lies within `bounds()` (inclusive; `max: null` = no upper bound). */
export function dateWithin(bounds: () => { readonly min: string; readonly max: string | null } | null): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    const limits = bounds();
    if (!limits || !isIsoDate(value)) return null;
    if (value < limits.min) return { beforeStart: { min: limits.min } };
    if (limits.max !== null && value > limits.max) return { afterEnd: { max: limits.max } };
    return null;
  };
}

/** Where each business rule of `POST /access/grants` is explained (docs/contracts/authorization.md › 409). */
export const GRANT_SLUGS: SlugTable = {
  'grant-self': { key: 'access.problems.grantSelf' },
  'grant-out-of-scope': { key: 'access.problems.grantOutOfScope', field: 'orgUnitId' },
  'grant-escalation': { key: 'access.problems.grantEscalation', field: 'roleId' },
  'grant-user-not-member': { key: 'access.problems.grantUserNotMember' },
  'grant-dates': { key: 'access.problems.grantDates', field: 'validTo' },
};

/** `POST /access/grants/:id/end`: same rules, the dialog has only `validTo`. */
export const END_GRANT_SLUGS: SlugTable = {
  'grant-self': { key: 'access.problems.endSelf' },
  'grant-out-of-scope': { key: 'access.problems.grantOutOfScope' },
  'grant-dates': { key: 'access.problems.endDates', field: 'validTo' },
};

/** `POST/PATCH /access/roles`. `role-escalation` lands on the checklist as a whole. */
export const ROLE_SLUGS: SlugTable = {
  'role-code-taken': { key: 'access.problems.roleCodeTaken', field: 'code' },
  'role-escalation': { key: 'access.problems.roleEscalation', field: 'permissions' },
  'role-system-immutable': { key: 'access.problems.roleSystemImmutable' },
};

/** Translation key for a control's first error (a server `serverKey` first). Server text (`server`) is shown as-is. */
export function fieldErrorKey(control: AbstractControl): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'access.form.errors.required';
  if (control.hasError('pattern')) return 'access.form.errors.codePattern';
  if (control.hasError('maxlength')) return 'access.form.errors.tooLong';
  if (control.hasError('isoDate')) return 'access.form.errors.invalidDate';
  if (control.hasError('beforeStart')) return 'access.end.errors.beforeStart';
  if (control.hasError('afterEnd')) return 'access.end.errors.afterEnd';
  return 'errors.generic';
}

export type GrantState = 'current' | 'future' | 'ended';

/** A grant's state on `today` from its `[validFrom, validTo)` range (the range is the truth, per the contract). */
export function grantState(grant: Pick<GrantView, 'validFrom' | 'validTo'>, today: string): GrantState {
  if (grant.validTo !== null && grant.validTo <= today) return 'ended';
  return grant.validFrom > today ? 'future' : 'current';
}
