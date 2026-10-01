import { sql, type Kysely } from 'kysely';
import { DEV_OIDC_KEY } from '../../../platform/config/env.schema.js';
import type { DB } from '../../../platform/db/schema.js';
import { DEMO_USERS } from '../../identity/index.js';
import { LEAVE_DEMO_USERS } from '../../leave/index.js';
import { DEMO_COMPANY_ID } from '../../organization/index.js';
import { deriveOidcKeys, seal } from './oidc-crypto.js';

/**
 * The DEMO company's connected app (docs/contracts/sso.md › Seed): `sso-demo` with a FIXED development secret (also
 * in apps/sso-demo/.env.example; INSECURE, development only), roles operator / supervisor, and two assignments by
 * rh.admin. With another OIDC_KEY than the development key the app gets invalid_client: rotate its secret.
 */
export const DEMO_SSO_CLIENT = {
  id: '0190a5d0-0000-7000-8000-000000000c01',
  clientId: 'sso-demo',
  secret: 'sso-demo-dev-secret-INSECURE-2026-0123456789',
  redirectUris: ['http://localhost:4300/callback'],
  postLogoutRedirectUris: ['http://localhost:4300/signed-out'],
  roles: {
    operator: { id: '0190a5d0-0000-7000-8000-000000000c11', names: { fr: 'Opérateur', ar: 'التشغيل', en: 'Operator' } },
    supervisor: { id: '0190a5d0-0000-7000-8000-000000000c12', names: { fr: 'Superviseur', ar: 'الإشراف', en: 'Supervisor' } },
  },
} as const;

export interface SeedSsoClient {
  id: string;
  companyId: string;
  clientId: string;
  name: string;
  nameAr: string | null;
  secret: string;
  redirectUris: readonly string[];
  postLogoutRedirectUris: readonly string[];
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post';
  roles: readonly { id: string; code: string; names: { fr: string; ar: string; en: string } }[];
  assignments: readonly { roleCode: string; userId: string; assignedBy: string | null }[];
}

/** Seeds one client with its roles and assignments (as the migrator); skipped when the client id exists. */
export async function seedSsoClient(tx: Kysely<DB>, client: SeedSsoClient, oidcKey: string = DEV_OIDC_KEY): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`select id from sso_client where client_id = ${client.clientId}`.execute(tx);
  if (rows.length > 0) return false;
  const { aead } = deriveOidcKeys(Buffer.from(oidcKey, 'base64'));
  await sql`insert into sso_client (id, company_id, client_id, name, name_ar, secret_enc, client_auth_method, redirect_uris, post_logout_redirect_uris)
            values (${client.id}::uuid, ${client.companyId}::uuid, ${client.clientId}, ${client.name}, ${client.nameAr},
                    ${seal(aead, client.secret, client.clientId)}, ${client.clientAuthMethod ?? 'client_secret_basic'},
                    ${[...client.redirectUris]}::text[], ${[...client.postLogoutRedirectUris]}::text[])`.execute(tx);
  for (const role of client.roles) {
    await sql`insert into sso_app_role (id, company_id, sso_client_id, code, name_fr, name_ar, name_en)
              values (${role.id}::uuid, ${client.companyId}::uuid, ${client.id}::uuid, ${role.code}, ${role.names.fr}, ${role.names.ar}, ${role.names.en})`.execute(tx);
  }
  for (const a of client.assignments) {
    const role = client.roles.find((r) => r.code === a.roleCode);
    if (!role) throw new Error(`seedSsoClient: unknown role ${a.roleCode}`);
    await sql`insert into sso_role_assignment (company_id, sso_app_role_id, user_id, assigned_by)
              values (${client.companyId}::uuid, ${role.id}::uuid, ${a.userId}::uuid, ${a.assignedBy}::uuid)`.execute(tx);
  }
  return true;
}

function userId(list: readonly { id: string; email: string }[], email: string): string {
  const user = list.find((u) => u.email === email);
  if (!user) throw new Error(`demo user ${email}`);
  return user.id;
}

/** seed:dev — the `sso-demo` app of the DEMO company (needs the identity and leave demo users). */
export function seedDemoSso(tx: Kysely<DB>, oidcKey: string = DEV_OIDC_KEY): Promise<boolean> {
  const admin = userId(DEMO_USERS, 'rh.admin@demo.dz');
  return seedSsoClient(
    tx,
    {
      id: DEMO_SSO_CLIENT.id,
      companyId: DEMO_COMPANY_ID,
      clientId: DEMO_SSO_CLIENT.clientId,
      name: 'Démo SSO',
      nameAr: 'تطبيق تجريبي للدخول الموحد',
      secret: DEMO_SSO_CLIENT.secret,
      redirectUris: DEMO_SSO_CLIENT.redirectUris,
      postLogoutRedirectUris: DEMO_SSO_CLIENT.postLogoutRedirectUris,
      roles: [
        { id: DEMO_SSO_CLIENT.roles.operator.id, code: 'operator', names: DEMO_SSO_CLIENT.roles.operator.names },
        { id: DEMO_SSO_CLIENT.roles.supervisor.id, code: 'supervisor', names: DEMO_SSO_CLIENT.roles.supervisor.names },
      ],
      assignments: [
        { roleCode: 'operator', userId: userId(LEAVE_DEMO_USERS, 'agent.annaba@demo.dz'), assignedBy: admin },
        { roleCode: 'supervisor', userId: userId(LEAVE_DEMO_USERS, 'chef.annaba@demo.dz'), assignedBy: admin },
      ],
    },
    oidcKey,
  );
}
