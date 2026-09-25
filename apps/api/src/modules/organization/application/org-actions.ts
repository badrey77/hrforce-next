import { Injectable } from '@nestjs/common';
import { PermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { requireContext } from '../../../platform/context/request-context.js';
import type { KindCatalogue, OrgAction, OrgUnitKind } from '../domain/org-unit.js';

export const ORG_PERMISSIONS = {
  read: 'org_unit.read',
  create: 'org_unit.create',
  update: 'org_unit.update',
} as const;

export const SITE_PERMISSIONS = {
  read: 'site.read',
  create: 'site.create',
} as const;

/** Computes `_actions` from the PermissionEvaluator (called inside the request transaction). */
@Injectable()
export class OrgActions {
  constructor(private readonly evaluator: PermissionEvaluator) {}

  /**
   * Resolves the caller's org permissions once per request and returns the per-unit action function.
   * org_unit.update → 'update'; org_unit.create → 'create_child' on units whose kind is an allowed parent of some
   * kind (per the kind catalogue: DG, department, region, agency — not service).
   * (Permissions are not org-scoped yet: the Authorization module will pass the unit as scope.)
   */
  async forCaller(kinds: KindCatalogue): Promise<(kind: OrgUnitKind) => OrgAction[]> {
    const { userId, companyId } = requireContext();
    const identity = { userId, companyId };
    const canUpdate = await this.evaluator.hasPermission(identity, ORG_PERMISSIONS.update);
    const canCreate = await this.evaluator.hasPermission(identity, ORG_PERMISSIONS.create);
    return (kind) => {
      const actions: OrgAction[] = [];
      if (canUpdate) actions.push('update');
      if (canCreate && kinds.canHaveChildren(kind)) actions.push('create_child');
      return actions;
    };
  }
}
