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
 * - 403 `forbidden-scope` (authorization contract: the parent is readable but not creatable/movable-into) is a
 *   business rule too, with `errors[{field:'parentId'}]`: it goes through the same slug path as a 409, so the move
 *   form shows it on its `parentId` picker; the create form (whose parent is fixed, no control) shows it form-level.
 *   Any other 403 stays the generic "forbidden".
 * - v2 site slugs are always about one field, even if the server omits `errors[]`: `org-unit-root-site-required`
 *   and `site-not-found` → `siteId`, `site-code-taken` → `code` (see SLUG_FIELDS).
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import { type ApiFieldError, type ApiProblem, isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
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
  'org-unit-root-site-required': 'org.problems.rootSiteRequired',
  'site-code-taken': 'org.problems.siteCodeTaken',
  'site-not-found': 'org.problems.siteNotFound',
  'forbidden-scope': 'org.problems.forbiddenScope',
};

/** Field a slug is about when the problem carries no `errors[]` (contract: these always concern one field). */
const SLUG_FIELDS: Readonly<Partial<Record<OrgProblemSlug, string>>> = {
  'org-unit-root-site-required': 'siteId',
  'site-not-found': 'siteId',
  'site-code-taken': 'code',
  'forbidden-scope': 'parentId',
};

function slugOf(type: string): OrgProblemSlug | undefined {
  if (!type.startsWith(ORG_PROBLEM_PREFIX)) return undefined;
  const slug = type.slice(ORG_PROBLEM_PREFIX.length);
  return slug in SLUG_KEYS ? (slug as OrgProblemSlug) : undefined;
}

/**
 * For a known business-rule slug, the field shows the TRANSLATED slug message (`{ serverKey }`, read by
 * `fieldErrorKey`), not the server's `message`: the API writes its messages in English only.
 */
function applySlugErrors(form: FormGroup, problem: ApiProblem, slug: OrgProblemSlug): ApiFieldError[] {
  const key = SLUG_KEYS[slug];
  const defaultField = SLUG_FIELDS[slug];
  const errors: readonly ApiFieldError[] = problem.errors?.length
    ? problem.errors
    : defaultField
      ? [{ field: defaultField, code: slug, message: '' }]
      : [];
  const unmatched: ApiFieldError[] = [];
  for (const error of errors) {
    const control = form.get(error.field);
    if (!control) {
      unmatched.push(error);
      continue;
    }
    control.setErrors({ ...control.errors, serverKey: key });
    control.markAsTouched();
  }
  return unmatched;
}

/** How many field errors a problem produces (its `errors[]`, or the slug's default field). */
function fieldErrorCount(problem: ApiProblem, slug: OrgProblemSlug | undefined): number {
  if (problem.errors?.length) return problem.errors.length;
  return slug && SLUG_FIELDS[slug] ? 1 : 0;
}

/** Applies field errors to `form` and returns the form-level message to show, if any. */
export function orgWriteError(form: FormGroup, error: unknown): FormError | null {
  if (!isApiProblemError(error)) {
    return { key: 'errors.generic' };
  }
  const { problem } = error;
  const status = problem.status === 403 && slugOf(problem.type) === 'forbidden-scope' ? 409 : problem.status;
  switch (status) {
    case 400:
    case 409:
    case 422: {
      const slug = slugOf(problem.type);
      const unmatched = slug ? applySlugErrors(form, problem, slug) : applyServerErrors(form, problem);
      const matchedSome = fieldErrorCount(problem, slug) > unmatched.length;
      if (matchedSome && unmatched.length === 0) return null;
      if (slug) return { key: SLUG_KEYS[slug] };
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

/** Contract: code `^[A-Z0-9][A-Z0-9_-]{1,31}$` (units and sites), names 1–120 chars once trimmed. */
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
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'org.form.errors.required';
  if (control.hasError('pattern')) return 'org.form.errors.codePattern';
  if (control.hasError('maxlength')) return 'org.form.errors.nameTooLong';
  if (control.hasError('isoDate')) return 'org.form.errors.invalidDate';
  return 'errors.generic';
}
