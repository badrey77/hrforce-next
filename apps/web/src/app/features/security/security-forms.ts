/**
 * Problem slugs of the `/me/mfa*` endpoints → where the security page shows them (see core/http/problem-form.ts for
 * how a slug table works). Plain TypeScript.
 */
import type { SlugTable } from '../../core/http/problem-form';

export const MFA_CODE_SLUGS: SlugTable = {
  'mfa-invalid': { key: 'security.errors.invalidCode', field: 'code' },
  'mfa-already-enabled': { key: 'security.errors.alreadyEnabled' },
  'mfa-required-by-policy': { key: 'security.errors.requiredByPolicy' },
};
