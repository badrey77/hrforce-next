/**
 * Authorization API types — copied from the binding contract `docs/contracts/authorization.md` › New endpoints.
 * Keep field names exactly as written there: the API builds against the same text. Plain TypeScript, no Angular.
 *
 * Lives in core/ (not features/access/): the Employees screens will need grants and roles too, and a feature must
 * never import another feature.
 */

/** Text in every UI language, written by the business (permission labels, role names). */
export interface LocalizedText {
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

/** Catalogue group codes (data; the web translates them under `access.groups.<code>`, falling back to the code). */
export type PermissionGroup = string;

/** `GET /access/permissions` item. */
export interface Permission {
  readonly code: string;
  readonly group: PermissionGroup;
  /** Salary, bank, NSS, medical… — flagged in the UI. */
  readonly sensitive: boolean;
  readonly labels: LocalizedText;
}

/** `GET /access/permissions` — sorted by group, then sortOrder. */
export interface PermissionList {
  readonly items: readonly Permission[];
}

/** `GET /access/roles` item; also the response of POST / PATCH. */
export interface Role {
  readonly id: string;
  readonly code: string;
  readonly names: LocalizedText;
  /** Seeded roles: permissions cannot be changed through the API (409 `role-system-immutable`). */
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export interface RoleList {
  readonly items: readonly Role[];
}

/** `POST /access/roles` body → 201 `Role`. */
export interface CreateRole {
  readonly code: string;
  readonly names: LocalizedText;
  readonly permissions: readonly string[];
}

/** `PATCH /access/roles/:id` body. */
export interface UpdateRole {
  readonly names?: LocalizedText;
  readonly permissions?: readonly string[];
}

export type GrantAction = 'end';

/** A role grant: a role, on an org unit (optionally its sub-units), for `[validFrom, validTo)`. */
export interface GrantView {
  readonly id: string;
  readonly userId: string;
  readonly role: { readonly id: string; readonly code: string; readonly names: LocalizedText };
  readonly unit: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly includeDescendants: boolean;
  readonly validFrom: string;
  /** Exclusive end; `null` = open. */
  readonly validTo: string | null;
  readonly grantedBy: { readonly id: string; readonly displayName: string } | null;
  readonly grantedAt: string;
  /** What the caller may do on this grant (the server's decision: scope + separation of duties). */
  readonly _actions: readonly GrantAction[];
}

export interface GrantList {
  readonly items: readonly GrantView[];
}

/** Account status (docs/contracts/identity.md › `auth.user_account.status`). */
export type UserStatus = 'invited' | 'active' | 'disabled';

/** `GET /access/users?q=` item: a member of the company with their current and future grants. */
export interface AccessUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly grants: readonly GrantView[];
  /**
   * The employee this account is linked to (docs/contracts/leave.md › Links: `user_employment`, needed for
   * self-service). Absent from an API before the Leave step → treated as "not linked".
   */
  readonly employment?: LinkedEmployment | null;
}

/** The linked employment as shown on the user detail. */
export interface LinkedEmployment {
  readonly id: string;
  readonly matricule: string;
  readonly person: {
    readonly lastName: string;
    readonly firstName: string;
    readonly lastNameAr: string | null;
    readonly firstNameAr: string | null;
  };
}

export interface AccessUserList {
  readonly items: readonly AccessUser[];
}

/** `GET /access/grants` query. */
export interface GrantQuery {
  readonly userId?: string;
  readonly unitId?: string;
  readonly includeEnded?: boolean;
}

/** `POST /access/grants` body → 201 `GrantView`. `validTo` absent = open-ended. */
export interface CreateGrant {
  readonly userId: string;
  readonly roleId: string;
  readonly orgUnitId: string;
  readonly includeDescendants: boolean;
  readonly validFrom: string;
  readonly validTo?: string;
}

/** `POST /access/grants/:id/end` body → 200 `GrantView`. `validTo` ≥ validFrom and ≤ the current end. */
export interface EndGrant {
  readonly validTo: string;
}

/** 409 business-rule slugs of the Authorization contract (`type: urn:hrforce:problem:<slug>`). */
export type AccessProblemSlug =
  | 'grant-self'
  | 'grant-out-of-scope'
  | 'grant-escalation'
  | 'grant-user-not-member'
  | 'grant-dates'
  | 'grant-duplicate'
  | 'role-code-taken'
  | 'role-escalation'
  | 'role-system-immutable'
  | 'forbidden-scope';
