import { Injectable } from '@nestjs/common';
import { PermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { canHaveChildren, type OrgAction, type OrgUnitKind } from '../domain/org-unit.js';

export const ORG_PERMISSIONS = {
  read: 'org_unit.read',
  create: 'org_unit.create',
  update: 'org_unit.update',
} as const;

/** Computes `_actions` from the PermissionEvaluator (called inside the request transaction). */
@Injectable()
export class OrgActions {
  constructor(private readonly evaluator: PermissionEvaluator) {}

  /**
   * Resolves the caller's org permissions once per request and returns the per-unit action function.
   * org_unit.update → 'update'; org_unit.create → 'create_child' on units that can have children (company, region).
   * (Permissions are not org-scoped yet: the Authorization module will pass the unit as scope.)
   */
  async forCaller(): Promise<(kind: OrgUnitKind) => OrgAction[]> {
    const { userId, companyId } = requireContext();
    const identity = { userId, companyId };
    const canUpdate = await this.evaluator.hasPermission(identity, ORG_PERMISSIONS.update);
    const canCreate = await this.evaluator.hasPermission(identity, ORG_PERMISSIONS.create);
    return (kind) => {
      const actions: OrgAction[] = [];
      if (canUpdate) actions.push('update');
      if (canCreate && canHaveChildren(kind)) actions.push('create_child');
      return actions;
    };
  }
}
