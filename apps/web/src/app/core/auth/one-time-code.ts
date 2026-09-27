/**
 * Helpers for authenticator (TOTP) codes typed by the user — shared by the login code step and the security page.
 *
 * Angular concept: a **validator is just a function** `(control) => errors | null` (`ValidatorFn`). This one accepts
 * "123456" and "123 456" (some apps display the code in two groups) and reports `{ pattern: true }` otherwise, the
 * same error key `Validators.pattern` would use, so templates handle both alike.
 */
import type { ValidatorFn } from '@angular/forms';
import { TOTP_CODE_PATTERN } from './auth.models';

/** `"123 456"` → `"123456"`. */
export function normalizeTotp(value: string): string {
  return value.replace(/\s+/g, '');
}

export function isCompleteTotp(value: string): boolean {
  return TOTP_CODE_PATTERN.test(normalizeTotp(value));
}

/** Validator: 6 digits once spaces are removed (empty is left to `Validators.required`). */
export const totpCode: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (value === '' || value === null) return null;
  return typeof value === 'string' && isCompleteTotp(value) ? null : { pattern: true };
};
