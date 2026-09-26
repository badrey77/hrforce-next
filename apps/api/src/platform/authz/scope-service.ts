import { sql, type OperandExpression } from 'kysely';
import { currentTx, requireContext } from '../context/request-context.js';
import { requestMemo } from '../context/request-memo.js';
import { NIL_UUID } from '../db/database.js';
import { PermissionEvaluator } from './permission-evaluator.js';

/**
 * A Kysely sub-query selecting org-unit ids (one column), for `where('u.id', 'in', scope)`.
 * Built on the request transaction; only valid inside the current request.
 */
export type UnitIdQuery = OperandExpression<string>;

/** One entry of a permission's scope: a unit, and whether its sub-units are covered too. */
export interface ScopeEntry {
  unitId: string;
  includeDescendants: boolean;
}

/** The caller's effective access (GET /api/me): codes held anywhere (sorted) and where each one applies. */
export interface AccessSummary {
  permissions: string[];
  scopes: Record<string, ScopeEntry[]>;
}

/**
 * Seam for org-unit SCOPE (ADR 002, docs/contracts/authorization.md › Evaluation). The guard only checks that a
 * permission is held somewhere ({@link PermissionEvaluator}); repositories and use cases ask this service WHERE:
 *  - `scopeOf(code)`  → sub-query of the unit ids the caller may act on with `code` today (filter queries with it);
 *  - `inScope(code, unitId)` → one unit;
 *  - `unitIds(code)` → the same set, materialised (tree rendering, `_actions`);
 *  - `covers(code, unitId, withDescendants)` → the unit (and its whole subtree) is inside the scope;
 *  - `coversCompany(code)` → every unit of today's tree is inside the scope.
 * Everything runs in the request transaction (tenant + RLS) and is memoised per request.
 * Implemented by the Authorization module (grants); {@link CompanyWideScopeService} is the flat fallback used with
 * DEV_PERMISSIONS=allow_all and with test evaluators (a held permission covers every unit of the company).
 */
export abstract class ScopeService {
  abstract scopeOf(code: string): Promise<UnitIdQuery>;
  abstract inScope(code: string, unitId: string): Promise<boolean>;
  abstract unitIds(code: string): Promise<ReadonlySet<string>>;
  abstract covers(code: string, unitId: string, withDescendants: boolean): Promise<boolean>;
  abstract coversCompany(code: string): Promise<boolean>;
  abstract summary(): Promise<AccessSummary>;
}

function tenantOrNil(): string {
  return requireContext().companyId ?? NIL_UUID;
}

/**
 * Flat scopes: a permission the {@link PermissionEvaluator} grants covers ALL units of the caller's company
 * (DEV_PERMISSIONS=allow_all: "every scope is all units of the company"); a permission it refuses covers none.
 */
export class CompanyWideScopeService extends ScopeService {
  constructor(private readonly evaluator: PermissionEvaluator) {
    super();
  }

  private held(code: string): Promise<boolean> {
    return requestMemo(`flat-scope:held:${code}`, () => {
      const { userId, companyId } = requireContext();
      return this.evaluator.hasPermission({ userId, companyId }, code);
    });
  }

  async scopeOf(code: string): Promise<UnitIdQuery> {
    const held = await this.held(code);
    return currentTx()
      .selectFrom('org_unit')
      .select('id as unit_id')
      .where('company_id', '=', tenantOrNil())
      .where(sql<boolean>`${held}`);
  }

  async inScope(code: string, unitId: string): Promise<boolean> {
    if (!(await this.held(code))) return false;
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', tenantOrNil()).where('id', '=', unitId).executeTakeFirst();
    return row !== undefined;
  }

  async unitIds(code: string): Promise<ReadonlySet<string>> {
    if (!(await this.held(code))) return new Set();
    const units = await requestMemo('flat-scope:all-units', async () =>
      (await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', tenantOrNil()).execute()).map((r) => r.id),
    );
    return new Set(units);
  }

  covers(code: string, unitId: string): Promise<boolean> {
    return this.inScope(code, unitId);
  }

  coversCompany(code: string): Promise<boolean> {
    return this.held(code);
  }

  async summary(): Promise<AccessSummary> {
    const tx = currentTx();
    const catalogue = await tx.selectFrom('permission').select('code').orderBy('code').execute();
    const root = await tx.selectFrom('org_unit').select('id').where('company_id', '=', tenantOrNil()).where('is_root', '=', true).executeTakeFirst();
    const permissions: string[] = [];
    const scopes: Record<string, ScopeEntry[]> = {};
    for (const { code } of catalogue) {
      if (!(await this.held(code))) continue;
      permissions.push(code);
      scopes[code] = root ? [{ unitId: root.id, includeDescendants: true }] : [];
    }
    return { permissions, scopes };
  }
}
