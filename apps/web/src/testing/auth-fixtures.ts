import type { Me } from '../app/core/auth/auth.models';

/**
 * `admin_rh_central`: everything except `employee.medical.read` (docs/contracts/authorization.md › Catalogue), plus
 * `audit.read` (docs/contracts/audit.md › Permission).
 */
export const ADMIN_PERMISSIONS: readonly string[] = [
  'access.grant',
  'access.manage_roles',
  'access.read',
  'audit.read',
  'employee.bank.read',
  'employee.create',
  'employee.nss.read',
  'employee.read',
  'employee.salary.read',
  'employee.update',
  'org_unit.create',
  'org_unit.read',
  'org_unit.update',
  'site.create',
  'site.read',
];

/** A `GET /api/me` body shaped like the dev seed (identity.md › CLI and seed; authorization.md › Dev seed grants). */
export const ME_FIXTURE: Me = {
  user: { id: 'u-amina', email: 'rh.admin@demo.dz', displayName: 'Amina Benali', locale: 'fr' },
  company: { id: 'c-demo', code: 'DEMO', name: 'Groupe Démo' },
  companies: [{ id: 'c-demo', code: 'DEMO', name: 'Groupe Démo' }],
  permissions: ADMIN_PERMISSIONS,
  scopes: Object.fromEntries(ADMIN_PERMISSIONS.map((code) => [code, [{ unitId: 'dg', includeDescendants: true }]])),
};

/** `ME_FIXTURE` with exactly these permissions (all scoped to the root unit with sub-units). */
export function meWith(permissions: readonly string[], base: Me = ME_FIXTURE): Me {
  return {
    ...base,
    permissions: permissions.toSorted(),
    scopes: Object.fromEntries(permissions.map((code) => [code, [{ unitId: 'dg', includeDescendants: true }]])),
  };
}

/** `lecture.ouest@demo.dz` — role `lecture` on REG-OUEST: org_unit.read, site.read, employee.read. */
export const ME_LECTURE: Me = {
  ...meWith(['employee.read', 'org_unit.read', 'site.read']),
  user: { id: 'u-samir', email: 'lecture.ouest@demo.dz', displayName: 'Samir Belkacem', locale: 'fr' },
  scopes: {
    'employee.read': [{ unitId: 'r-ouest', includeDescendants: true }],
    'org_unit.read': [{ unitId: 'r-ouest', includeDescendants: true }],
    'site.read': [{ unitId: 'r-ouest', includeDescendants: true }],
  },
};

/** Same user, Arabic account locale (like `rh.est@demo.dz`). */
export const ME_AR: Me = {
  ...ME_FIXTURE,
  user: { id: 'u-karim', email: 'rh.est@demo.dz', displayName: 'Karim Haddad', locale: 'ar' },
};

/** Policy requires two-step sign-in and the user has not set it up (docs/contracts/mfa.md › Enforcement). */
export const ME_MFA_REQUIRED: Me = { ...ME_FIXTURE, mfa: { enabled: false, required: true, recoveryCodesLeft: null } };
/** Two-step sign-in on, 10 recovery codes left. */
export const ME_MFA_ON: Me = { ...ME_FIXTURE, mfa: { enabled: true, required: true, recoveryCodesLeft: 10 } };
