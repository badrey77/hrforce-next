import type { ScopeEntry } from '../../../platform/authz/scope-service.js';
import type { Locale } from '../domain/account.js';

/** GET /api/me (docs/contracts/identity.md + authorization.md: `permissions` and `scopes`). */
export interface MeView {
  user: { id: string; email: string; displayName: string; locale: Locale };
  company: CompanyView;
  companies: CompanyView[];
  /** Permission codes held anywhere today, sorted. */
  permissions: string[];
  /** Per held code, the units (with/without sub-units) it is effective at. */
  scopes: Record<string, ScopeEntry[]>;
}

export interface CompanyView {
  id: string;
  code: string;
  name: string;
}
