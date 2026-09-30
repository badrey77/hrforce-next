/**
 * Form helpers of the attendance screens: the "reason" rule (3–500 characters, trimmed — manual punch, void, kiosk
 * revocation) and `attendanceProblemToForm()`, which extends `problemToForm()` (core/http/problem-form.ts) with a
 * table of 422 FIELD codes. Plain functions over the Forms API (no DI), unit-tested.
 *
 * Why a second table: the API names validation failures with a stable `code` per field (`time` + `future`,
 * `date` + `too_old`, `validFrom` + … ) and an English `message`. `problemToForm()` shows that English message; for
 * the codes a person is likely to meet, this table shows OUR translated sentence on the right control instead
 * (`{ serverKey }`, as for business-rule slugs). Anything not in the table falls through to `problemToForm()`.
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { REASON_MAX, REASON_MIN } from '../../core/attendance/attendance.models';
import { ApiProblemError, isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';

/**
 * `'<field>:<code>'` → translation key, e.g. `'time:future': 'attendance.manual.timeFuture'`, or `{ key, control }`
 * when the form's control has another path than the API's field (`target.id` → `targetId`).
 */
export type FieldCodeTable = Readonly<Record<string, string | { readonly key: string; readonly control: string }>>;

/** Required, 3–500 characters once trimmed (errors `required`, `minlength`, `maxlength` with the usual params). */
export function reasonValidator(min = REASON_MIN, max = REASON_MAX): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = typeof control.value === 'string' ? control.value.trim() : '';
    if (value.length === 0) return { required: true };
    if (value.length < min) return { minlength: { requiredLength: min, actualLength: value.length } };
    if (value.length > max) return { maxlength: { requiredLength: max, actualLength: value.length } };
    return null;
  };
}

/** Translation key of a reason control's first error. */
export function reasonErrorKey(control: AbstractControl): string {
  if (control.hasError('serverKey')) return String(control.getError('serverKey'));
  if (control.hasError('maxlength')) return 'attendance.reason.tooLong';
  if (control.hasError('minlength')) return 'attendance.reason.tooShort';
  return 'attendance.reason.required';
}

export function attendanceProblemToForm(
  form: FormGroup,
  error: unknown,
  slugs: SlugTable,
  codes: FieldCodeTable = {},
  notFoundKey?: string,
): FormMessage | null {
  if (!isApiProblemError(error) || !error.problem.errors?.length) return problemToForm(form, error, slugs, notFoundKey);
  const rest = [];
  for (const fieldError of error.problem.errors) {
    const rule = codes[`${fieldError.field}:${fieldError.code}`];
    const key = typeof rule === 'string' ? rule : rule?.key;
    const control = rule ? form.get(typeof rule === 'string' ? fieldError.field : rule.control) : null;
    if (key && control) {
      control.setErrors({ ...control.errors, serverKey: key });
      control.markAsTouched();
    } else {
      rest.push(fieldError);
    }
  }
  if (rest.length === error.problem.errors.length) return problemToForm(form, error, slugs, notFoundKey);
  if (rest.length === 0) return null;
  return problemToForm(form, new ApiProblemError({ ...error.problem, errors: rest }, { cause: error.cause }), slugs, notFoundKey);
}
