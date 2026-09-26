import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { ScopeService, type AccessSummary, type ScopeEntry, type UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx, requireContext } from '../../../platform/context/request-context.js';
import { requestMemo } from '../../../platform/context/request-memo.js';
import type { RequestIdentity } from '../../../platform/context/request-identity.js';
import { NIL_UUID } from '../../../platform/db/database.js';
import { AccessClock } from './access-clock.js';

/** One effective grant of the caller (valid today, unit in today's tree) with its role's permissions. */
export interface EffectiveGrant {
  grantId: string;
  unitId: string;
  includeDescendants: boolean;
  permissions: string[];
}

function caller(): { userId: string; companyId: string } {
  const { userId, companyId } = requireContext();
  return { userId: userId ?? NIL_UUID, companyId: companyId ?? NIL_UUID };
}

/**
 * Grant-backed scopes (docs/contracts/authorization.md › Evaluation):
 *   effective grants = role_grant rows of the caller, in the caller's company, with `valid @> today`
 *                      (`ended_at` is irrelevant: the range is the truth);
 *   scope(code)      = ∪ over effective grants whose role holds `code`: the grant's unit, plus its descendants
 *                      (org_unit_closure, i.e. today's tree) when include_descendants.
 * Everything reads through the request transaction (tenant settings + RLS) and is memoised per request.
 */
@Injectable()
export class GrantScopeService extends ScopeService {
  constructor(private readonly clock: AccessClock) {
    super();
  }

  /** The caller's effective grants (memoised per request). */
  effectiveGrants(): Promise<EffectiveGrant[]> {
    return requestMemo('grants:effective', async () => {
      const { userId, companyId } = caller();
      const rows = await currentTx()
        .selectFrom('role_grant as g')
        .innerJoin('role_permission as rp', (join) => join.onRef('rp.company_id', '=', 'g.company_id').onRef('rp.role_id', '=', 'g.role_id'))
        // the grant's unit must be part of today's tree (self row of the closure)
        .innerJoin('org_unit_closure as s', (join) =>
          join.onRef('s.company_id', '=', 'g.company_id').onRef('s.ancestor_id', '=', 'g.org_unit_id').onRef('s.descendant_id', '=', 'g.org_unit_id'),
        )
        .select(['g.id', 'g.org_unit_id', 'g.include_descendants', sql<string[]>`array_agg(rp.permission_code order by rp.permission_code)`.as('permissions')])
        .where('g.company_id', '=', companyId)
        .where('g.user_id', '=', userId)
        .where(sql<boolean>`g.valid @> ${this.clock.today()}::date`)
        .groupBy(['g.id', 'g.org_unit_id', 'g.include_descendants'])
        .orderBy('g.id')
        .execute();
      return rows.map((r) => ({ grantId: r.id, unitId: r.org_unit_id, includeDescendants: r.include_descendants, permissions: r.permissions }));
    });
  }

  /** Held anywhere = the scope is non-empty. */
  async holds(code: string): Promise<boolean> {
    return (await this.effectiveGrants()).some((g) => g.permissions.includes(code));
  }

  private scopeQuery(code: string) {
    const { userId, companyId } = caller();
    return currentTx()
      .selectFrom('org_unit_closure as c')
      .innerJoin('role_grant as g', (join) => join.onRef('g.company_id', '=', 'c.company_id').onRef('g.org_unit_id', '=', 'c.ancestor_id'))
      .innerJoin('role_permission as rp', (join) => join.onRef('rp.company_id', '=', 'g.company_id').onRef('rp.role_id', '=', 'g.role_id'))
      .select('c.descendant_id as unit_id')
      .where('c.company_id', '=', companyId)
      .where('g.user_id', '=', userId)
      .where('rp.permission_code', '=', code)
      .where(sql<boolean>`g.valid @> ${this.clock.today()}::date`)
      .where((eb) => eb.or([eb('g.include_descendants', '=', true), eb('c.depth', '=', 0)]));
  }

  scopeOf(code: string): Promise<UnitIdQuery> {
    return Promise.resolve(this.scopeQuery(code));
  }

  inScope(code: string, unitId: string): Promise<boolean> {
    return requestMemo(`grants:in:${code}:${unitId}`, async () => {
      const row = await this.scopeQuery(code).where('c.descendant_id', '=', unitId).limit(1).executeTakeFirst();
      return row !== undefined;
    });
  }

  unitIds(code: string): Promise<ReadonlySet<string>> {
    return requestMemo(`grants:ids:${code}`, async () => new Set((await this.scopeQuery(code).execute()).map((r) => r.unit_id)));
  }

  covers(code: string, unitId: string, withDescendants: boolean): Promise<boolean> {
    if (!withDescendants) return this.inScope(code, unitId);
    return requestMemo(`grants:covers:${code}:${unitId}`, async () => {
      if (!(await this.inScope(code, unitId))) return false;
      const { companyId } = caller();
      const gap = await currentTx()
        .selectFrom('org_unit_closure as t')
        .select('t.descendant_id')
        .where('t.company_id', '=', companyId)
        .where('t.ancestor_id', '=', unitId)
        .where('t.descendant_id', 'not in', this.scopeQuery(code))
        .limit(1)
        .executeTakeFirst();
      return gap === undefined;
    });
  }

  coversCompany(code: string): Promise<boolean> {
    return requestMemo(`grants:company:${code}`, async () => {
      if (!(await this.holds(code))) return false;
      const { companyId } = caller();
      const gap = await currentTx()
        .selectFrom('org_unit_closure as t')
        .select('t.descendant_id')
        .where('t.company_id', '=', companyId)
        .where('t.depth', '=', 0)
        .where('t.descendant_id', 'not in', this.scopeQuery(code))
        .limit(1)
        .executeTakeFirst();
      return gap === undefined;
    });
  }

  async summary(): Promise<AccessSummary> {
    const byCode = new Map<string, Map<string, boolean>>();
    for (const grant of await this.effectiveGrants()) {
      for (const code of grant.permissions) {
        const units = byCode.get(code) ?? new Map<string, boolean>();
        units.set(grant.unitId, (units.get(grant.unitId) ?? false) || grant.includeDescendants);
        byCode.set(code, units);
      }
    }
    const permissions = [...byCode.keys()].toSorted();
    const scopes: Record<string, ScopeEntry[]> = {};
    for (const code of permissions) {
      scopes[code] = [...(byCode.get(code) ?? new Map<string, boolean>())]
        .map(([unitId, includeDescendants]) => ({ unitId, includeDescendants }))
        .toSorted((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
    }
    return { permissions, scopes };
  }
}

/** The real PermissionEvaluator: a permission is held when its scope is non-empty today. */
@Injectable()
export class GrantPermissionEvaluator extends PermissionEvaluator {
  constructor(private readonly scopes: GrantScopeService) {
    super();
  }

  hasPermission(identity: RequestIdentity, permission: string): Promise<boolean> {
    if (!identity.userId || !identity.companyId) return Promise.resolve(false);
    return this.scopes.holds(permission);
  }
}
