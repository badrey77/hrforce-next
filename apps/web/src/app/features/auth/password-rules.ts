/**
 * Password form rules for the setup page, mirroring the server (docs/contracts/identity.md › Passwords).
 *
 * Angular concepts:
 * - **A FormGroup-level (cross-field) validator.** A `ValidatorFn` attached to a CONTROL only sees that
 *   control's value, so it cannot compare "password" with "confirm". Attached to the GROUP
 *   (`fb.group({...}, { validators: [passwordsMatch] })`), it receives the group and can read any child. Angular
 *   re-runs it whenever any child value changes, and its result lands on `group.errors` — NOT on the confirm
 *   control. The template therefore checks `form.hasError('passwordMismatch')` to show the message next to the
 *   confirm field (and sets that field's `aria-invalid` itself).
 * - Why not put the error on the confirm control with `setErrors()` from inside the validator: validators
 *   should be pure (value in, errors out). Writing to another control from a validator fights Angular's own
 *   revalidation, which would wipe the error on the next keystroke in that control.
 *
 * Client checks mirror only what the browser can know: length 12–128. "Must not contain the email's local part"
 * and "not a common password" need the account and the server's list, so they come back as 422 codes.
 */
import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** Group validator: `{ passwordMismatch: true }` when `confirm` is filled and differs from `password`. */
export const passwordsMatch: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const password: unknown = group.get('password')?.value;
  const confirm: unknown = group.get('confirm')?.value;
  if (!confirm) {
    return null; // left to `required` on the confirm control
  }
  return password === confirm ? null : { passwordMismatch: true };
};

/** 422 `errors[{field:'password', code}]` codes → translation keys. Unknown codes show the server message. */
export const PASSWORD_SERVER_ERROR_KEYS: Readonly<Record<string, string>> = {
  too_short: 'auth.passwordSetup.serverErrors.tooShort',
  too_long: 'auth.passwordSetup.serverErrors.tooLong',
  contains_email: 'auth.passwordSetup.serverErrors.containsEmail',
  common: 'auth.passwordSetup.serverErrors.common',
};
