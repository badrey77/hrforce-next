import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';

export interface SecurityPolicyRow {
  mfaEnforced: boolean;
  mfaRequiredPermissions: string[];
}

/**
 * public.security_policy (migration 0013) through the request transaction (tenant RLS). A company without a row has
 * the defaults: enforced, public.security_policy_default_permissions().
 */
@Injectable()
export class SecurityPolicyRepository {
  async get(companyId: string): Promise<SecurityPolicyRow> {
    const { rows } = await sql<{ mfa_enforced: boolean; mfa_required_permissions: string[] }>`
      select coalesce(sp.mfa_enforced, true) as mfa_enforced,
             coalesce(sp.mfa_required_permissions, public.security_policy_default_permissions()) as mfa_required_permissions
        from (select 1) as one
        left join public.security_policy sp on sp.company_id = ${companyId}::uuid`.execute(currentTx());
    const row = rows[0];
    if (!row) throw new Error('security policy query returned no row');
    return { mfaEnforced: row.mfa_enforced, mfaRequiredPermissions: row.mfa_required_permissions };
  }

  async upsert(companyId: string, policy: SecurityPolicyRow): Promise<void> {
    await sql`
      insert into public.security_policy (company_id, mfa_enforced, mfa_required_permissions, updated_at)
      values (${companyId}::uuid, ${policy.mfaEnforced}, ${policy.mfaRequiredPermissions}::text[], now())
      on conflict (company_id) do update
        set mfa_enforced = excluded.mfa_enforced,
            mfa_required_permissions = excluded.mfa_required_permissions,
            updated_at = excluded.updated_at
        where security_policy.mfa_enforced is distinct from excluded.mfa_enforced
           or security_policy.mfa_required_permissions is distinct from excluded.mfa_required_permissions`.execute(currentTx());
  }

  /** Whether the user's second factor is active (auth.mfa_status: only for the transaction's own user). */
  async mfaActive(userId: string): Promise<boolean> {
    const { rows } = await sql<{ status: string }>`select status from auth.mfa_status(${userId}::uuid)`.execute(currentTx());
    return rows[0]?.status === 'active';
  }
}
