import type { Me } from '../app/core/auth/auth.models';

/** A `GET /api/me` body shaped like the dev seed (docs/contracts/identity.md › CLI and seed). */
export const ME_FIXTURE: Me = {
  user: { id: 'u-amina', email: 'rh.admin@demo.dz', displayName: 'Amina Benali', locale: 'fr' },
  company: { id: 'c-demo', code: 'DEMO', name: 'Groupe Démo' },
  companies: [{ id: 'c-demo', code: 'DEMO', name: 'Groupe Démo' }],
};

/** Same user, Arabic account locale (like `rh.est@demo.dz`). */
export const ME_AR: Me = {
  ...ME_FIXTURE,
  user: { id: 'u-karim', email: 'rh.est@demo.dz', displayName: 'Karim Haddad', locale: 'ar' },
};
