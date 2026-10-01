import type { SsoAppRoleView, SsoAssignmentView, SsoClientCreatedView, SsoClientView } from '../app/core/sso/sso.models';

/** The seeded `operator` role of the DEMO `sso-demo` client (docs/contracts/sso.md › Seed). */
export const ROLE_OPERATOR: SsoAppRoleView = {
  id: 'ar-operator',
  code: 'operator',
  names: { fr: 'Opérateur', ar: 'التشغيل', en: 'Operator' },
  assignmentCount: 1,
  _actions: ['update'],
};
export const ROLE_SUPERVISOR: SsoAppRoleView = {
  id: 'ar-supervisor',
  code: 'supervisor',
  names: { fr: 'Superviseur', ar: 'الإشراف', en: 'Supervisor' },
  assignmentCount: 0,
  _actions: ['update', 'delete'],
};

/** `sso-demo` as a company-wide writer sees it. */
export const SSO_DEMO: SsoClientView = {
  id: 'c-sso-demo',
  clientId: 'sso-demo',
  name: 'Démo SSO',
  nameAr: 'تطبيق تجريبي للدخول الموحد',
  status: 'active',
  redirectUris: ['http://localhost:4300/callback'],
  postLogoutRedirectUris: ['http://localhost:4300/signed-out'],
  clientAuthMethod: 'client_secret_basic',
  credentialSetAt: '2026-09-30T08:00:00Z',
  issuer: 'http://localhost:4200/oidc',
  createdAt: '2026-09-30T08:00:00Z',
  createdBy: { id: 'u-amina', displayName: 'Amina Benali' },
  disabledAt: null,
  disabledReason: null,
  roles: [ROLE_OPERATOR, ROLE_SUPERVISOR],
  assignmentCount: 2,
  _actions: ['update', 'rotate_secret', 'disable', 'add_role'],
};

/** The same app as a regional admin (`acces`) sees it: read-only. */
export const SSO_DEMO_READ_ONLY: SsoClientView = {
  ...SSO_DEMO,
  roles: SSO_DEMO.roles.map((role) => ({ ...role, _actions: [] })),
  _actions: [],
};

export const SECRET = 'Zm9vYmFyLXNlY3JldC12YWx1ZS1zaG93bi1vbmNlLTQz';

export function created(view: SsoClientView = SSO_DEMO): SsoClientCreatedView {
  return { ...view, clientSecret: SECRET };
}

export function assignment(extra: Partial<SsoAssignmentView> = {}): SsoAssignmentView {
  return {
    id: 'as-1',
    user: { id: 'u-agent', email: 'agent.annaba@demo.dz', displayName: 'Nadia Agent' },
    client: { id: SSO_DEMO.id, clientId: SSO_DEMO.clientId, name: SSO_DEMO.name, nameAr: SSO_DEMO.nameAr },
    role: { id: ROLE_OPERATOR.id, code: ROLE_OPERATOR.code, names: ROLE_OPERATOR.names },
    assignedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    assignedAt: '2026-09-30T09:00:00Z',
    _actions: ['remove'],
    ...extra,
  };
}
