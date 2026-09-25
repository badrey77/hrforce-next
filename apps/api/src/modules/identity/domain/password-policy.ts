import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * Password rules (docs/contracts/identity.md › Passwords, NIST 800-63B): 12–128 characters, must not contain the
 * e-mail's local part (case-insensitive), must not be a common password. No composition rules.
 * Length is counted in Unicode code points (what a user perceives as characters, emoji included).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** Local parts shorter than this are not checked (a 1–2 letter local part would forbid half the alphabet). */
export const EMAIL_LOCAL_PART_MIN_CHECK = 3;

export type PasswordPolicyCode = 'too_short' | 'too_long' | 'contains_email' | 'common';

export interface PasswordPolicyViolation {
  code: PasswordPolicyCode;
  message: string;
}

export function checkPasswordPolicy(password: string, email: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    violations.push({ code: 'too_short', message: `Must be at least ${PASSWORD_MIN_LENGTH} characters.` });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push({ code: 'too_long', message: `Must be at most ${PASSWORD_MAX_LENGTH} characters.` });
  }
  const lower = password.toLowerCase();
  const localPart = (email.split('@')[0] ?? '').trim().toLowerCase();
  if (localPart.length >= EMAIL_LOCAL_PART_MIN_CHECK && lower.includes(localPart)) {
    violations.push({ code: 'contains_email', message: 'Must not contain your e-mail address.' });
  }
  if (COMMON_PASSWORDS.has(lower)) {
    violations.push({ code: 'common', message: 'This password is too common.' });
  }
  return violations;
}
