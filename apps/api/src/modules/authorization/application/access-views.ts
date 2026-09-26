/** Response shapes of docs/contracts/authorization.md (the API layer returns them as-is). */

export interface Labels {
  fr: string;
  ar: string;
  en: string;
}

export interface PermissionView {
  code: string;
  group: string;
  sensitive: boolean;
  labels: Labels;
}

export interface RoleView {
  id: string;
  code: string;
  names: Labels;
  isSystem: boolean;
  permissions: string[];
}

export type GrantAction = 'end';

export interface GrantView {
  id: string;
  userId: string;
  role: { id: string; code: string; names: Labels };
  unit: { id: string; code: string; name: string; kind: string };
  includeDescendants: boolean;
  validFrom: string;
  validTo: string | null;
  grantedBy: { id: string; displayName: string } | null;
  grantedAt: string;
  _actions: GrantAction[];
}

export interface AccessUserView {
  id: string;
  email: string;
  displayName: string;
  status: string;
  grants: GrantView[];
  /** the linked employee (self-service, docs/contracts/leave.md; set with PUT /access/users/:id/employment), or null */
  employment: LinkedEmploymentView | null;
}

export interface LinkedEmploymentView {
  id: string;
  matricule: string;
  person: { lastName: string; firstName: string; lastNameAr: string | null; firstNameAr: string | null };
}

export interface ItemsView<T> {
  items: T[];
}
