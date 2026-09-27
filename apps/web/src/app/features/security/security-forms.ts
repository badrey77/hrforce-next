/**
 * Problem slugs of the `/me/mfa*` endpoints → where the security page shows them (see core/http/problem-form.ts for
 * how a slug table works). Plain TypeScript.
 */
import type { SlugTable } from '../../core/http/problem-form';

export const MFA_CODE_SLUGS: SlugTable = {
  'mfa-invalid': { key: 'security.errors.invalidCode', field: 'code' },
  'mfa-already-enabled': { key: 'security.errors.alreadyEnabled' },
  'mfa-required-by-policy': { key: 'security.errors.requiredByPolicy' },
  // 409 when the factor is gone meanwhile (e.g. an admin reset it from another session)
  'mfa-not-enabled': { key: 'security.errors.notEnabled' },
  // 423: wrong codes here count toward the same per-e-mail lock as sign-in (apps/api/README.md › Two-step sign-in)
  'account-locked': { key: 'security.errors.locked' },
};
