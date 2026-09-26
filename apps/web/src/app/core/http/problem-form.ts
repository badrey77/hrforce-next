/**
 * `problemToForm()` — turns a failed write into what a reactive form shows, driven by a table of business-rule
 * slugs. Plain functions over the Forms API (no DI).
 *
 * Why a table: the API's 409 problems (`type: urn:hrforce:problem:<slug>`) name a rule, and the UI decides where
 * each rule is best explained — on a field (`grant-escalation` → the role select) or above the form
 * (`grant-self`). One table per form keeps that decision readable and testable:
 *
 *   problemToForm(form, error, {
 *     'grant-escalation': { key: 'access.problems.grantEscalation', field: 'roleId' },
 *     'grant-self': { key: 'access.problems.grantSelf' },
 *   })
 *
 * Rules:
 * - A known slug shows its TRANSLATED message (`{ serverKey: key }` on the control, or a form-level `{ key }`): the
 *   API writes its messages in English only. The table's `field` wins over `errors[].field`, because the field
 *   the server names may have no control in this form (`grant-user-not-member` names `userId`, which the user
 *   cannot edit on the user's own page) — then the message goes to the form level.
 * - Anything else with `errors[]` (typically 422 validation) goes through `applyServerErrors()` (server text on
 *   the named control); what matches no control becomes a form-level text.
 * - 403 → "forbidden", 404 → `notFoundKey`, network → "network", else "generic".
 *
 * `features/organization/org-forms.ts` predates this helper and keeps its own copy of the idea (with slug defaults
 * taken from `errors[]`); new forms use this one.
 */
import type { FormGroup } from '@angular/forms';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from './api-problem';
import { applyServerErrors } from './apply-server-errors';

/** A form-level message: a translation key, or text the server already wrote. */
export type FormMessage = { readonly key: string } | { readonly text: string };

/** Where a business-rule slug is shown: on `field` when that control exists, else above the form. */
export interface SlugRule {
  readonly key: string;
  readonly field?: string;
}

export type SlugTable = Readonly<Record<string, SlugRule>>;

export const PROBLEM_TYPE_PREFIX = 'urn:hrforce:problem:';

export function problemSlug(type: string): string | undefined {
  return type.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : undefined;
}

/** Applies field errors to `form` and returns the form-level message to show, if any. */
export function problemToForm(
  form: FormGroup,
  error: unknown,
  slugs: SlugTable,
  notFoundKey = 'errors.notFound',
): FormMessage | null {
  if (!isApiProblemError(error)) return { key: 'errors.generic' };
  const { problem } = error;
  const slug = problemSlug(problem.type);
  const rule = slug === undefined ? undefined : slugs[slug];

  if (rule) {
    const control = rule.field ? form.get(rule.field) : null;
    if (!control) return { key: rule.key };
    control.setErrors({ ...control.errors, serverKey: rule.key });
    control.markAsTouched();
    return null;
  }

  switch (problem.status) {
    case 400:
    case 409:
    case 422: {
      const unmatched = applyServerErrors(form, problem);
      const matched = (problem.errors?.length ?? 0) - unmatched.length;
      if (matched > 0 && unmatched.length === 0) return null;
      const text = unmatched[0]?.message || problem.detail || problem.title;
      return text ? { text } : { key: 'errors.generic' };
    }
    case 403:
      return { key: 'errors.forbidden' };
    case 404:
      return { key: notFoundKey };
    default:
      return { key: problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'errors.generic' };
  }
}
