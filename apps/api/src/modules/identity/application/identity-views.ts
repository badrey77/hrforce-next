import type { Locale } from '../domain/account.js';

/** GET /api/me (docs/contracts/identity.md). Authorization will add `permissions` and `scopes`. */
export interface MeView {
  user: { id: string; email: string; displayName: string; locale: Locale };
  company: CompanyView;
  companies: CompanyView[];
}

export interface CompanyView {
  id: string;
  code: string;
  name: string;
}
