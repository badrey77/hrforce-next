/**
 * Form helpers of Access → Applications (docs/contracts/sso.md › Validation): patterns, validators for URI lists, the
 * 409 slug tables and the mapping of the API's 422 codes to translated messages.
 *
 * Angular concepts:
 * - **Validators on a `FormArray`.** A redirect-URI list is a `FormArray<FormControl<string>>`: each ROW has its own
 *   validator (`redirectUri`: absolute http(s), no fragment, loopback-only `http`), and the ARRAY has validators about
 *   the list as a whole (`listSize`: at least one / at most ten; `noDuplicates`). An array validator receives the
 *   `FormArray` itself as its control and reads `.value` (a `string[]`); its error sits on the array, not on a row —
 *   the template shows it under the list.
 * - **Validator factories** (`listSize(min, max)`) return a `ValidatorFn` configured by their arguments (chapter 14).
 * - The rules mirror the API's so the person is told before submitting; the API stays the authority, and its 422
 *   `errors[{field, code}]` (e.g. `redirectUris.2` / `insecure_uri`) are mapped to the same translated messages by
 *   `ssoProblemToForm()` — `form.get('redirectUris.2')` finds a row of a FormArray by its index.
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';

export const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;
export const APP_ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const APP_NAME_MAX = 80;
export const URI_MAX = 2000;
export const URI_LIST_MAX = 10;
export const REASON_MIN = 3;
export const REASON_MAX = 500;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Contract › Validation: the code of the first problem of one URI, or `null` when it is acceptable. */
export function uriProblem(value: string): 'invalid_uri' | 'insecure_uri' | null {
  if (value.length > URI_MAX || value.includes('*') || value.includes('#')) return 'invalid_uri';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_uri';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid_uri';
  if (url.username || url.password) return 'invalid_uri';
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return 'insecure_uri';
  return null;
}

/** Row validator: `{ invalid_uri: true }` / `{ insecure_uri: true }`; an empty row is left to `Validators.required`. */
export const redirectUri: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value: unknown = control.value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const problem = uriProblem(value.trim());
  return problem ? { [problem]: true } : null;
};

/** Array validator factory: between `min` and `max` rows (`{ required }` / `{ too_many }`). */
export function listSize(min: number, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    const length = Array.isArray(value) ? value.length : 0;
    if (length < min) return { required: true };
    if (length > max) return { too_many: true };
    return null;
  };
}

/** Array validator: the same URI twice (after trimming) → `{ duplicate: true }` (exact matching: no normalisation). */
export const noDuplicates: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value: unknown = control.value;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const uri = item.trim();
    if (seen.has(uri)) return { duplicate: true };
    seen.add(uri);
  }
  return null;
};

/** Fails with `{ required: true }` for a whitespace-only string. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/** API 422 codes with a translated message (`sso.form.errors.<code>`). */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'required',
  'invalid',
  'too_long',
  'too_short',
  'too_many',
  'invalid_uri',
  'insecure_uri',
  'duplicate',
  'immutable',
  'taken',
  'not_member',
  'unknown',
]);

/** Translation key for a control's first error (a server `serverKey` first; server text `server` is shown as-is). */
export function ssoFieldErrorKey(control: AbstractControl, patternKey = 'sso.form.errors.invalid'): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'sso.form.errors.required';
  if (control.hasError('pattern')) return patternKey;
  if (control.hasError('maxlength')) return 'sso.form.errors.too_long';
  if (control.hasError('minlength')) return 'sso.form.errors.too_short';
  if (control.hasError('invalid_uri')) return 'sso.form.errors.invalid_uri';
  if (control.hasError('insecure_uri')) return 'sso.form.errors.insecure_uri';
  if (control.hasError('duplicate')) return 'sso.form.errors.duplicate';
  if (control.hasError('too_many')) return 'sso.form.errors.too_many';
  return 'errors.generic';
}

/**
 * Like `problemToForm()` (core/http/problem-form.ts), plus: a 422 whose `errors[].code` is a known contract code gets
 * the TRANSLATED message on its control (`serverKey`), instead of the API's English text.
 */
export function ssoProblemToForm(form: FormGroup, error: unknown, slugs: SlugTable, notFoundKey = 'sso.apps.notFound'): FormMessage | null {
  if (isApiProblemError(error) && error.status === 422 && error.problem.errors?.length) {
    let unmatched: FormMessage | null = null;
    for (const item of error.problem.errors) {
      const control = form.get(item.field);
      if (control && KNOWN_CODES.has(item.code)) {
        control.setErrors({ ...control.errors, serverKey: `sso.form.errors.${item.code}` });
        control.markAsTouched();
      } else {
        unmatched ??= KNOWN_CODES.has(item.code) ? { key: `sso.form.errors.${item.code}` } : { text: item.message || error.problem.title };
      }
    }
    return unmatched;
  }
  return problemToForm(form, error, slugs, notFoundKey);
}

/** Company-wide writers only (contract › Scope rules): a regional admin gets 403 `forbidden-scope`. */
const FORBIDDEN_SCOPE = { key: 'sso.problems.forbiddenScope' };

export const CLIENT_SLUGS: SlugTable = {
  'sso-client-id-taken': { key: 'sso.problems.clientIdTaken', field: 'clientId' },
  'forbidden-scope': FORBIDDEN_SCOPE,
};

export const CLIENT_STATUS_SLUGS: SlugTable = {
  'sso-client-disabled': { key: 'sso.problems.clientDisabled' },
  'sso-client-active': { key: 'sso.problems.clientActive' },
  'forbidden-scope': FORBIDDEN_SCOPE,
};

export const ROLE_SLUGS: SlugTable = {
  'sso-role-code-taken': { key: 'sso.problems.roleCodeTaken', field: 'code' },
  'sso-role-in-use': { key: 'sso.problems.roleInUse' },
  'forbidden-scope': FORBIDDEN_SCOPE,
};

export const ASSIGN_SLUGS: SlugTable = {
  'sso-assign-self': { key: 'sso.problems.assignSelf' },
  'sso-assignment-duplicate': { key: 'sso.problems.assignmentDuplicate', field: 'roleId' },
  'forbidden-scope': FORBIDDEN_SCOPE,
};
