import type { FormGroup } from '@angular/forms';
import type { ApiFieldError, ApiProblem } from './api-problem';

/**
 * Maps `problem.errors[].field` onto form controls as `{ server: message }`.
 * Dotted fields (`address.city`, `phones.0`) resolve through nested groups/arrays.
 * Returns the errors that matched no control, so callers can show them globally.
 */
export function applyServerErrors(form: FormGroup, problem: ApiProblem): ApiFieldError[] {
  const unmatched: ApiFieldError[] = [];
  for (const error of problem.errors ?? []) {
    const control = form.get(error.field);
    if (!control) {
      unmatched.push(error);
      continue;
    }
    control.setErrors({ ...control.errors, server: error.message });
    control.markAsTouched();
  }
  return unmatched;
}
