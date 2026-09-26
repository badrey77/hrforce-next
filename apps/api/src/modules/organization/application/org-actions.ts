import { Injectable } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
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

/**
 * Per-unit `_actions` from the caller's real scopes (platform ScopeService; called inside the request transaction):
 * `update` when org_unit.update covers the unit; `create_child` when org_unit.create covers it and its kind is an
 * allowed parent of some kind (per the kind catalogue: DG, department, region, agency — not service).
 */
@Injectable()
export class OrgActions {
  constructor(private readonly scopes: ScopeService) {}

  private static of(kinds: KindCatalogue, kind: OrgUnitKind, canUpdate: boolean, canCreate: boolean): OrgAction[] {
    const actions: OrgAction[] = [];
    if (canUpdate) actions.push('update');
    if (canCreate && kinds.canHaveChildren(kind)) actions.push('create_child');
    return actions;
  }

  /** For many units at once (the tree): the scopes are materialised once per request. */
  async forMany(kinds: KindCatalogue): Promise<(unitId: string, kind: OrgUnitKind) => OrgAction[]> {
    const [update, create] = await Promise.all([this.scopes.unitIds(ORG_PERMISSIONS.update), this.scopes.unitIds(ORG_PERMISSIONS.create)]);
    return (unitId, kind) => OrgActions.of(kinds, kind, update.has(unitId), create.has(unitId));
  }

  /** For one unit, whose scope is decided at `anchorId` (the unit itself, or its parent when not in today's tree). */
  async forUnit(kinds: KindCatalogue, anchorId: string, kind: OrgUnitKind): Promise<OrgAction[]> {
    const [canUpdate, canCreate] = await Promise.all([
      this.scopes.inScope(ORG_PERMISSIONS.update, anchorId),
      this.scopes.inScope(ORG_PERMISSIONS.create, anchorId),
    ]);
    return OrgActions.of(kinds, kind, canUpdate, canCreate);
  }
}
