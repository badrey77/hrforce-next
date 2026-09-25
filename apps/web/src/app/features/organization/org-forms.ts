/**
 * Form helpers shared by the create and change forms of this feature.
 *
 * Angular concepts:
 * - A **validator** (`ValidatorFn`) is a plain function `control => errors | null`; Angular runs it on every value
 *   change and merges the result into `control.errors`. `notBlank` complements `Validators.required`, which accepts
 *   a whitespace-only string.
 *
 * `orgWriteError` turns a failed org write (POST/PATCH) into what the form shows, around two existing pieces:
 * `ApiProblemError` (every HttpClient failure, thanks to `apiProblemInterceptor`) and `applyServerErrors()`
 * (puts `{ server: message }` on the control named by each `errors[].field`).
 *
 * Contract rules applied here:
 * - 422 → `errors[]` with `field` = body property → the matching control shows the message.
 * - 409 → business rule, `type: urn:hrforce:problem:<slug>`; with `errors[]` when tied to a field (e.g. code taken
 *   → the `code` control). A 409 with no field, or whose field has no control in this form, becomes a form-level
 *   message, translated from the slug when we know it, else the server's `detail`/`title`.
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { applyServerErrors } from '../../core/http/apply-server-errors';
import { ORG_PROBLEM_PREFIX, type OrgProblemSlug } from '../../core/org/org.models';

/** A form-level message: a translation key, or text the server already wrote. */
export type FormError = { readonly key: string } | { readonly text: string };

const SLUG_KEYS: Readonly<Record<OrgProblemSlug, string>> = {
  'org-unit-code-taken': 'org.problems.codeTaken',
  'org-unit-invalid-parent': 'org.problems.invalidParent',
  'org-unit-cycle': 'org.problems.cycle',
  'org-unit-version-overlap': 'org.problems.versionOverlap',
  'org-unit-root-immutable': 'org.problems.rootImmutable',
};

function slugKey(type: string): string | undefined {
  if (!type.startsWith(ORG_PROBLEM_PREFIX)) return undefined;
  const slug = type.slice(ORG_PROBLEM_PREFIX.length);
  return slug in SLUG_KEYS ? SLUG_KEYS[slug as OrgProblemSlug] : undefined;
}

/** Applies field errors to `form` and returns the form-level message to show, if any. */
export function orgWriteError(form: FormGroup, error: unknown): FormError | null {
  if (!isApiProblemError(error)) {
    return { key: 'errors.generic' };
  }
  const { problem } = error;
  switch (problem.status) {
    case 400:
    case 409:
    case 422: {
      const unmatched = applyServerErrors(form, problem);
      const matchedSome = (problem.errors?.length ?? 0) > unmatched.length;
      if (matchedSome && unmatched.length === 0) return null;
      const key = slugKey(problem.type);
      if (key) return { key };
      const text = unmatched[0]?.message || problem.detail || problem.title;
      return text ? { text } : { key: 'errors.generic' };
    }
    case 403:
      return { key: 'errors.forbidden' };
    case 404:
      return { key: 'org.problems.notFound' };
    default:
      return { key: problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'errors.generic' };
  }
}

/** Contract: code `^[A-Z0-9][A-Z0-9_-]{1,31}$`, names 1–120 chars once trimmed. */
export const ORG_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
export const ORG_NAME_MAX = 120;

/** Fails with `{ required: true }` for a whitespace-only string. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/** Fails with `{ isoDate: true }` unless the value is empty (left to `required`) or a real `YYYY-MM-DD` date. */
export const isoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  !control.value || isIsoDate(control.value) ? null : { isoDate: true };

/** Translation key for a control's first client-side error (server errors carry their own text). */
export function fieldErrorKey(control: AbstractControl): string {
  if (control.hasError('required')) return 'org.form.errors.required';
  if (control.hasError('pattern')) return 'org.form.errors.codePattern';
  if (control.hasError('maxlength')) return 'org.form.errors.nameTooLong';
  if (control.hasError('isoDate')) return 'org.form.errors.invalidDate';
  return 'errors.generic';
}
