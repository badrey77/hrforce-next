/**
 * Authorization — pure reference data (docs/contracts/authorization.md › Catalogue). No Nest, no Kysely.
 * The permission catalogue itself lives in the database (table `permission`, seeded by migration 0008); these
 * constants name the codes the code base uses and define the system roles seeded per company.
 */

export const ACCESS_PERMISSIONS = {
  read: 'access.read',
  grant: 'access.grant',
  manageRoles: 'access.manage_roles',
} as const;

/** Every code of the catalogue (migrations 0008, 0009, 0010, 0011), in catalogue order. A unit test keeps this in sync with the DB. */
export const PERMISSION_CODES = [
  'org_unit.read',
  'org_unit.create',
  'org_unit.update',
  'site.read',
  'site.create',
  'access.read',
  'access.grant',
  'access.manage_roles',
  'audit.read',
  'employee.read',
  'employee.create',
  'employee.update',
  'employee.salary.read',
  'employee.salary.update',
  'employee.bank.read',
  'employee.bank.update',
  'employee.nss.read',
  'employee.nss.update',
  'employee.medical.read',
  'leave.request_self',
  'leave.read',
  'leave.request',
  'leave.approve_hr',
  'leave.adjust',
  'leave.configure',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export interface Names {
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

export interface SystemRole {
  readonly code: string;
  readonly names: Names;
  readonly permissions: readonly PermissionCode[];
}

/**
 * System roles (is_system = true, permissions immutable through the API). By default only admin_rh_central holds the
 * salary / bank / NSS permissions and NO seeded role holds employee.medical.read (contract assumption).
 */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    code: 'admin_rh_central',
    names: { fr: 'Administrateur RH central', ar: 'مسؤول الموارد البشرية المركزي', en: 'Central HR administrator' },
    permissions: PERMISSION_CODES.filter((code) => code !== 'employee.medical.read'),
  },
  {
    code: 'rh_regional',
    names: { fr: 'RH régional', ar: 'مسؤول الموارد البشرية الجهوي', en: 'Regional HR' },
    permissions: [
      'org_unit.read', 'site.read', 'employee.read', 'employee.create', 'employee.update',
      'leave.read', 'leave.request', 'leave.approve_hr', 'leave.adjust',
    ],
  },
  {
    code: 'lecture',
    names: { fr: 'Lecture seule', ar: 'اطلاع فقط', en: 'Read only' },
    permissions: ['org_unit.read', 'site.read', 'employee.read'],
  },
  {
    code: 'admin_acces',
    names: { fr: 'Administrateur des accès', ar: 'مسؤول الصلاحيات', en: 'Access administrator' },
    permissions: ['org_unit.read', 'site.read', 'access.read', 'access.grant', 'access.manage_roles', 'audit.read'],
  },
  {
    // self-service (docs/contracts/leave.md): request one's own leave; the manager step needs no permission
    code: 'employe',
    names: { fr: 'Employé (libre-service)', ar: 'موظف (الخدمة الذاتية)', en: 'Employee (self-service)' },
    permissions: ['leave.request_self'],
  },
];

/** Role codes: the unit-code alphabet in either case (system codes are lower snake_case), 2–32 characters. */
export const ROLE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
export const ROLE_NAME_MAX = 120;
