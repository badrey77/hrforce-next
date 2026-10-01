/** Response shapes of the SSO endpoints (docs/contracts/sso.md › Endpoints). */

export interface SsoInteractionView {
  uid: string;
  client: { clientId: string; name: string; nameAr: string | null };
  freshLoginRequired: boolean;
}

export interface SsoRedirectView {
  redirectTo: string;
}

export interface SsoAppRoleView {
  id: string;
  code: string;
  names: { fr: string; ar: string; en: string };
  assignmentCount: number;
  _actions: ('update' | 'delete')[];
}

export interface SsoClientView {
  id: string;
  clientId: string;
  name: string;
  nameAr: string | null;
  status: 'active' | 'disabled';
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  credentialSetAt: string;
  issuer: string;
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  disabledAt: string | null;
  disabledReason: string | null;
  roles: SsoAppRoleView[];
  assignmentCount: number;
  _actions: ('update' | 'rotate_secret' | 'disable' | 'enable' | 'add_role')[];
}

/** Create and rotate-secret only: `clientSecret` is shown ONCE (docs/contracts/sso.md, secret-fields-allow.json). */
export interface SsoClientCreatedView extends SsoClientView {
  clientSecret: string;
}

export interface SsoAssignmentView {
  id: string;
  user: { id: string; email: string; displayName: string };
  client: { id: string; clientId: string; name: string; nameAr: string | null };
  role: { id: string; code: string; names: { fr: string; ar: string; en: string } };
  assignedBy: { id: string; displayName: string } | null;
  assignedAt: string;
  _actions: 'remove'[];
}
