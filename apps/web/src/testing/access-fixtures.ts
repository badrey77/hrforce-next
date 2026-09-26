import type { HttpTestingController } from '@angular/common/http/testing';
import type { AccessUser, GrantView, Permission, Role } from '../app/core/access/access.models';

function permission(code: string, group: string, fr: string, ar: string, en: string, sensitive = false): Permission {
  return { code, group, sensitive, labels: { fr, ar, en } };
}

/** The seeded catalogue (docs/contracts/authorization.md › Catalogue), in API order (group, then sortOrder). */
export const PERMISSIONS: readonly Permission[] = [
  permission('org_unit.read', 'organization', 'Consulter l’organisation', 'الاطلاع على التنظيم', 'View organization'),
  permission('org_unit.create', 'organization', 'Créer des unités', 'إنشاء الوحدات', 'Create units'),
  permission('org_unit.update', 'organization', 'Modifier des unités', 'تعديل الوحدات', 'Change units'),
  permission('site.read', 'organization', 'Consulter les sites', 'الاطلاع على المواقع', 'View sites'),
  permission('site.create', 'organization', 'Créer des sites', 'إنشاء المواقع', 'Create sites'),
  permission('access.read', 'access', 'Consulter les accès', 'الاطلاع على الصلاحيات', 'View access'),
  permission('access.grant', 'access', 'Attribuer des rôles', 'إسناد الأدوار', 'Grant roles'),
  permission('access.manage_roles', 'access', 'Gérer les rôles', 'إدارة الأدوار', 'Manage roles'),
  permission('employee.read', 'employee', 'Consulter les employés', 'الاطلاع على الموظفين', 'View employees'),
  permission('employee.create', 'employee', 'Créer des employés', 'إنشاء الموظفين', 'Create employees'),
  permission('employee.update', 'employee', 'Modifier des employés', 'تعديل الموظفين', 'Change employees'),
  permission('employee.salary.read', 'sensitive', 'Voir le salaire', 'الاطلاع على الراتب', 'View salary', true),
  permission('employee.bank.read', 'sensitive', 'Voir le RIB', 'الاطلاع على الحساب البنكي', 'View bank details', true),
  permission('employee.nss.read', 'sensitive', 'Voir le NSS', 'الاطلاع على رقم الضمان الاجتماعي', 'View NSS', true),
  permission('employee.medical.read', 'sensitive', 'Voir le dossier médical', 'الاطلاع على الملف الطبي', 'View medical file', true),
];

export const ROLE_ADMIN: Role = {
  id: 'role-admin',
  code: 'admin_rh_central',
  names: { fr: 'Administrateur RH central', ar: 'مسؤول الموارد البشرية المركزي', en: 'Central HR administrator' },
  isSystem: true,
  permissions: PERMISSIONS.map((p) => p.code).filter((code) => code !== 'employee.medical.read'),
};
export const ROLE_LECTURE: Role = {
  id: 'role-lecture',
  code: 'lecture',
  names: { fr: 'Lecture', ar: 'قراءة', en: 'Read only' },
  isSystem: true,
  permissions: ['org_unit.read', 'site.read', 'employee.read'],
};
export const ROLE_CUSTOM: Role = {
  id: 'role-paie',
  code: 'GEST-PAIE',
  names: { fr: 'Gestionnaire paie', ar: 'مسير الأجور', en: 'Payroll officer' },
  isSystem: false,
  permissions: ['employee.read', 'employee.salary.read'],
};
export const ROLES: readonly Role[] = [ROLE_ADMIN, ROLE_LECTURE, ROLE_CUSTOM];

export function grant(extra: Partial<GrantView> & Pick<GrantView, 'id' | 'userId'>): GrantView {
  return {
    role: { id: ROLE_LECTURE.id, code: ROLE_LECTURE.code, names: ROLE_LECTURE.names },
    unit: { id: 'r-ouest', code: 'REG-OUEST', name: 'Région Ouest', kind: 'region' },
    includeDescendants: true,
    validFrom: '2026-01-01',
    validTo: null,
    grantedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    grantedAt: '2026-01-01T08:00:00Z',
    _actions: ['end'],
    ...extra,
  };
}

export const GRANT_SAMIR = grant({ id: 'g-samir', userId: 'u-samir' });

export const USER_SAMIR: AccessUser = {
  id: 'u-samir',
  email: 'lecture.ouest@demo.dz',
  displayName: 'Samir Belkacem',
  status: 'active',
  grants: [GRANT_SAMIR],
};
export const USER_NEW: AccessUser = {
  id: 'u-nadia',
  email: 'nadia.k@demo.dz',
  displayName: 'Nadia Kaci',
  status: 'invited',
  grants: [],
};
export const USERS: readonly AccessUser[] = [USER_SAMIR, USER_NEW];

/** Answers the AccessCatalog's two requests (permissions + roles); call after a `TestBed.tick()`. */
export function flushAccessCatalog(http: HttpTestingController, roles: readonly Role[] = ROLES): void {
  http.expectOne('/api/access/permissions').flush({ items: PERMISSIONS });
  http.expectOne('/api/access/roles').flush({ items: roles });
}
