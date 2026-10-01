/**
 * SSO API types — copied from the binding contract `docs/contracts/sso.md` (› Sign-in handoff, › Administration).
 * Keep field names exactly as written there: the API builds against the same text. Plain TypeScript, no Angular.
 *
 * Lives in core/ (not features/): the handoff page (features/sso) and the Access screens (features/access) both use
 * these types, and a feature must never import another feature.
 */
import type { LocalizedText } from '../access/access.models';
import type { AppLanguage } from '../i18n/languages';

// --- Sign-in handoff (`/api/sso/interactions/:uid/*`) --------------------------------------------------------------

/** `GET /sso/interactions/:uid/details` — which app is asking, and whether it wants a fresh sign-in. */
export interface SsoInteractionView {
  readonly uid: string;
  readonly client: { readonly clientId: string; readonly name: string; readonly nameAr: string | null };
  /** The request asks for a fresh sign-in AND the caller's HRForce session does not satisfy it (false when signed out). */
  readonly freshLoginRequired: boolean;
}

/** `POST …/complete` and `POST …/abort` → where the browser goes next (`<issuer>/auth/<uid>`). */
export interface SsoRedirect {
  readonly redirectTo: string;
}

// --- Administration (`/api/sso/clients`, `/api/sso/roles`, `/api/sso/assignments`) ---------------------------------

export type SsoClientStatus = 'active' | 'disabled';
export type SsoClientAuthMethod = 'client_secret_basic' | 'client_secret_post';
export const SSO_AUTH_METHODS: readonly SsoClientAuthMethod[] = ['client_secret_basic', 'client_secret_post'];

export type SsoClientAction = 'update' | 'rotate_secret' | 'disable' | 'enable' | 'add_role';
export type SsoAppRoleAction = 'update' | 'delete';

export interface SsoAppRoleView {
  readonly id: string;
  readonly code: string;
  readonly names: LocalizedText;
  readonly assignmentCount: number;
  /** `delete` only when `assignmentCount = 0`. */
  readonly _actions: readonly SsoAppRoleAction[];
}

export interface SsoClientView {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly status: SsoClientStatus;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
  readonly clientAuthMethod: SsoClientAuthMethod;
  /** ISO instant the current secret was issued. */
  readonly credentialSetAt: string;
  /** `${WEB_BASE_URL}/oidc`, for the "how to connect" panel. */
  readonly issuer: string;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string } | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  /** Sorted by code. */
  readonly roles: readonly SsoAppRoleView[];
  /** Users with at least one role of this app. */
  readonly assignmentCount: number;
  readonly _actions: readonly SsoClientAction[];
}

/**
 * Create and rotate-secret only. `clientSecret` is shown ONCE and is never readable again: the page keeps it in a
 * component signal and clears it (features/access/secret-panel.ts). Never store it in a service, storage or the URL.
 */
export interface SsoClientCreatedView extends SsoClientView {
  readonly clientSecret: string;
}

export interface SsoClientList {
  readonly items: readonly SsoClientView[];
}

/** `POST /sso/clients` body. */
export interface CreateSsoClient {
  readonly clientId: string;
  readonly name: string;
  readonly nameAr?: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris?: readonly string[];
  readonly clientAuthMethod?: SsoClientAuthMethod;
}

/** `PATCH /sso/clients/:id` body (`clientId` is immutable). `nameAr: null` clears the Arabic name. */
export interface UpdateSsoClient {
  readonly name?: string;
  readonly nameAr?: string | null;
  readonly redirectUris?: readonly string[];
  readonly postLogoutRedirectUris?: readonly string[];
  readonly clientAuthMethod?: SsoClientAuthMethod;
}

/** `POST /sso/clients/:id/roles` body. */
export interface CreateSsoAppRole {
  readonly code: string;
  readonly names: LocalizedText;
}

export type SsoAssignmentAction = 'remove';

export interface SsoAssignmentView {
  readonly id: string;
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly client: { readonly id: string; readonly clientId: string; readonly name: string; readonly nameAr: string | null };
  readonly role: { readonly id: string; readonly code: string; readonly names: LocalizedText };
  readonly assignedBy: { readonly id: string; readonly displayName: string } | null;
  readonly assignedAt: string;
  readonly _actions: readonly SsoAssignmentAction[];
}

export interface SsoAssignmentList {
  readonly items: readonly SsoAssignmentView[];
}

/** `GET /sso/assignments` filters (optional, AND-ed). */
export interface SsoAssignmentQuery {
  readonly clientId?: string;
  readonly userId?: string;
  readonly roleId?: string;
}

/** `POST /sso/assignments` body. */
export interface CreateSsoAssignment {
  readonly userId: string;
  readonly roleId: string;
}

/** Problem slugs of the SSO contract (`type: urn:hrforce:problem:<slug>`). */
export type SsoProblemSlug =
  | 'sso-interaction-not-found'
  | 'sso-client-unavailable'
  | 'sso-not-member'
  | 'sso-fresh-login-required'
  | 'sso-client-id-taken'
  | 'sso-client-disabled'
  | 'sso-client-active'
  | 'sso-role-code-taken'
  | 'sso-role-in-use'
  | 'sso-assign-self'
  | 'sso-assignment-duplicate';

/** The scopes an app asks for (contract › Claims). */
export const SSO_SCOPES = 'openid profile email hrforce';

/** An app's name in the UI language: the Arabic name when the UI is Arabic and it exists, else the name. */
export function ssoAppName(client: { readonly name: string; readonly nameAr: string | null }, lang: AppLanguage): string {
  return lang === 'ar' && client.nameAr ? client.nameAr : client.name;
}
