/**
 * Authorization — pure rules (separation of duties, grant dates). Dates are ISO `YYYY-MM-DD` strings (they compare
 * correctly as strings). Contract: docs/contracts/authorization.md › Separation of duties.
 */

export type AccessProblemSlug =
  | 'grant-self'
  | 'grant-out-of-scope'
  | 'grant-escalation'
  | 'grant-user-not-member'
  | 'grant-dates'
  | 'grant-duplicate'
  | 'role-code-taken'
  | 'role-system-immutable'
  | 'role-escalation';

export type AccessField = 'userId' | 'roleId' | 'orgUnitId' | 'validFrom' | 'validTo' | 'code' | 'permissions';

/** A business-rule violation (→ 409 problem `urn:hrforce:problem:<slug>`, `errors[]` on `field` when set). */
export class AccessRuleViolation extends Error {
  constructor(
    readonly slug: AccessProblemSlug,
    message: string,
    readonly field?: AccessField,
    readonly code: string = slug,
  ) {
    super(message);
    this.name = 'AccessRuleViolation';
  }
}

/** Nobody grants to, or ends grants of, themselves. */
export function assertNotSelf(callerId: string, userId: string, action: 'grant' | 'end'): void {
  if (callerId === userId) {
    throw new AccessRuleViolation(
      'grant-self',
      action === 'grant' ? 'You cannot grant access to yourself.' : 'You cannot end your own grants.',
      'userId',
    );
  }
}

/** A new grant covers [validFrom, validTo): validTo, when given, must be after validFrom (else it is never effective). */
export function assertNewGrantDates(validFrom: string, validTo: string | null): void {
  if (validTo !== null && validTo <= validFrom) {
    throw new AccessRuleViolation('grant-dates', 'The end date must be after the start date.', 'validTo');
  }
}

/**
 * Ending a grant sets its exclusive end `validTo`: not before its start (validTo = validFrom cancels a grant that has
 * not started, or ends one on its first day) and never later than its current end (a grant can only be shortened).
 */
export function assertEndDate(grant: { validFrom: string; validTo: string | null }, validTo: string): void {
  if (validTo < grant.validFrom) {
    throw new AccessRuleViolation('grant-dates', `The end date cannot be before the start date (${grant.validFrom}).`, 'validTo');
  }
  if (grant.validTo !== null && validTo > grant.validTo) {
    throw new AccessRuleViolation('grant-dates', `The end date cannot be after the current end (${grant.validTo}).`, 'validTo');
  }
}

/** Effective on `today` for a [from, to) range. */
export function isEffective(grant: { validFrom: string; validTo: string | null }, today: string): boolean {
  return grant.validFrom <= today && (grant.validTo === null || today < grant.validTo);
}

/** Current or future (not yet ended) on `today`. */
export function isCurrentOrFuture(grant: { validTo: string | null }, today: string): boolean {
  return grant.validTo === null || today < grant.validTo;
}

/** Permissions added by an edit (the only ones subject to role-escalation). */
export function addedPermissions(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return [...new Set(after)].filter((code) => !had.has(code));
}
