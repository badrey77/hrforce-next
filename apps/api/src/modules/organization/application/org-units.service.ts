import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import {
  assertNoCycle,
  assertParentAllowed,
  assertRootSite,
  OrgRuleViolation,
  type OrgUnitKind,
} from '../domain/org-unit.js';
import { ancestorPath, buildTree, effectiveSite, type OrgSnapshotUnit, type OrgTree } from '../domain/tree.js';
import { planNewVersion, sortVersions, versionAt } from '../domain/versions.js';
import { OrgKindRepository } from '../infra/org-kind.repository.js';
import { constraintViolation, OrgUnitRepository } from '../infra/org-unit.repository.js';
import { SiteRepository } from '../infra/site.repository.js';
import { OrgActions, ORG_PERMISSIONS } from './org-actions.js';
import { OrgClock } from './org-clock.js';
import type { OrgKindsView, OrgTreeNode, OrgTreeView, OrgUnitDetail, OrgUnitSearchView, SiteRef } from './org-views.js';

export const SEARCH_LIMIT = 50;

export interface CreateOrgUnitInput {
  kind: OrgUnitKind;
  code: string;
  name: string;
  nameAr?: string | null | undefined;
  parentId: string;
  siteId?: string | null | undefined;
  validFrom?: string | undefined;
}

export interface ChangeOrgUnitInput {
  name?: string | undefined;
  /** undefined = unchanged; null = remove the Arabic name. */
  nameAr?: string | null | undefined;
  parentId?: string | undefined;
  /** undefined = unchanged; null = inherit from the nearest ancestor. */
  siteId?: string | null | undefined;
  validFrom?: string | undefined;
}

export interface SearchOrgUnitsInput {
  q?: string | undefined;
  kind?: readonly OrgUnitKind[] | undefined;
  asOf?: string | undefined;
}

/** A caller without a tenant has no organisation: everything is "not found". */
export function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw new NotFoundException('Organisation not found');
  return companyId;
}

function unitNotFound(): NotFoundException {
  return new NotFoundException('Org unit not found');
}

/**
 * The unit is readable but the caller's scope does not allow the action there (docs/contracts/authorization.md ›
 * Scope rules): 403 `forbidden-scope`, with the body field when the scope check was on a referenced unit.
 */
function forbiddenScope(detail: string, field?: 'parentId'): ProblemException {
  return new ProblemException(403, 'forbidden-scope', detail, field ? [{ field, code: 'forbidden_scope', message: detail }] : undefined);
}

/** Kinds come from the catalogue, so an unknown (or, for creation, root) kind is an invalid body/query value → 422. */
function invalidKind(message: string): ValidationProblemException {
  return new ValidationProblemException([{ field: 'kind', code: 'invalid_value', message }]);
}

/** Use cases of the Organization module. Everything runs in the request transaction. */
@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly repo: OrgUnitRepository,
    private readonly kinds: OrgKindRepository,
    private readonly sites: SiteRepository,
    private readonly actions: OrgActions,
    private readonly clock: OrgClock,
    private readonly scopes: ScopeService,
  ) {}

  async listKinds(): Promise<OrgKindsView> {
    const catalogue = await this.kinds.catalogue();
    return { items: catalogue.kinds.map((k) => ({ ...k, labels: { ...k.labels }, allowedParents: [...k.allowedParents] })) };
  }

  async getTree(asOf?: string): Promise<OrgTreeView> {
    const companyId = tenant();
    const date = asOf ?? this.clock.today();
    const catalogue = await this.kinds.catalogue();
    const snapshot = await this.repo.snapshot(companyId, date);
    const tree = buildTree(snapshot, catalogue);
    if (!tree) throw new NotFoundException(`No organisation exists on ${date}`);
    const readable = await this.scopes.unitIds(ORG_PERMISSIONS.read);
    if (readable.size === 0) throw new ForbiddenException('No org_unit.read scope');
    const siteRefs = await this.siteRefs(companyId, snapshot.map((u) => u.siteId));
    const actionsOf = await this.actions.forMany(catalogue);
    // Nodes in scope, plus their ancestors as context (inScope false, no actions); branches with nothing in scope
    // are omitted. The root is always returned (as context when out of scope).
    const toNode = (node: OrgTree, inheritedSiteId: string | null): OrgTreeNode | null => {
      const siteId = node.unit.siteId ?? inheritedSiteId;
      const children = node.children.map((child) => toNode(child, siteId)).filter((child): child is OrgTreeNode => child !== null);
      const inScope = readable.has(node.unit.id);
      if (!inScope && children.length === 0 && node !== tree) return null;
      return {
        id: node.unit.id,
        kind: node.unit.kind,
        code: node.unit.code,
        name: node.unit.name,
        nameAr: node.unit.nameAr ?? null,
        site: siteId ? (siteRefs.get(siteId) ?? null) : null,
        inScope,
        children,
        _actions: inScope ? actionsOf(node.unit.id, node.unit.kind) : [],
      };
    };
    const root = toNode(tree, null);
    if (!root) throw new NotFoundException(`No organisation exists on ${date}`);
    return { asOf: date, root };
  }

  async searchUnits(params: SearchOrgUnitsInput): Promise<OrgUnitSearchView> {
    const companyId = tenant();
    const asOf = params.asOf ?? this.clock.today();
    if (params.kind?.length) {
      const catalogue = await this.kinds.catalogue();
      const unknown = params.kind.filter((k) => !catalogue.has(k));
      if (unknown.length) throw invalidKind(`Unknown kind: ${unknown.join(', ')}`);
    }
    const ids = await this.repo.search(companyId, {
      asOf,
      scope: await this.scopes.scopeOf(ORG_PERMISSIONS.read),
      limit: SEARCH_LIMIT,
      ...(params.q ? { q: params.q } : {}),
      ...(params.kind?.length ? { kinds: params.kind } : {}),
    });
    if (ids.length === 0) return { items: [] };
    const snapshot = await this.repo.snapshot(companyId, asOf);
    const byId = new Map(snapshot.map((u) => [u.id, u]));
    const found = ids.flatMap((id) => byId.get(id) ?? []);
    const effective = new Map(found.map((u) => [u.id, effectiveSite(u.siteId, u.parentId, byId).siteId]));
    const siteRefs = await this.siteRefs(companyId, [...effective.values()]);
    const items = found.map((unit) => {
      const siteId = effective.get(unit.id);
      return {
        id: unit.id,
        kind: unit.kind,
        code: unit.code,
        name: unit.name,
        nameAr: unit.nameAr ?? null,
        site: siteId ? (siteRefs.get(siteId) ?? null) : null,
        path: ancestorPath(unit.parentId, byId),
      };
    });
    return { items };
  }

  /**
   * One unit with its history (newest first). name / path / effective site come from the version valid today, or —
   * for a unit whose first version starts in the future — from that first version (as of its start date).
   */
  async getUnit(id: string): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const unit = await this.repo.findUnit(companyId, id);
    if (!unit) throw unitNotFound();
    const versions = sortVersions(await this.repo.listVersions(companyId, id));
    const today = this.clock.today();
    const todays = versionAt(versions, today);
    const shown = todays ?? versions[0];
    if (!shown) throw unitNotFound();
    const anchor = await this.scopeAnchor(companyId, id, shown.parentId);
    if (!(await this.scopes.inScope(ORG_PERMISSIONS.read, anchor))) throw unitNotFound();
    const snapshot = await this.repo.snapshot(companyId, todays ? today : shown.validFrom);
    const byId = new Map<string, OrgSnapshotUnit>(snapshot.map((u) => [u.id, u]));
    const site = effectiveSite(shown.siteId, shown.parentId, byId);
    const siteRefs = await this.siteRefs(companyId, [site.siteId]);
    const catalogue = await this.kinds.catalogue();
    const actions = await this.actions.forUnit(catalogue, anchor, unit.kind);
    return {
      id: unit.id,
      kind: unit.kind,
      code: unit.code,
      name: shown.name,
      nameAr: shown.nameAr ?? null,
      site: site.siteId ? (siteRefs.get(site.siteId) ?? null) : null,
      siteInherited: site.inherited,
      path: ancestorPath(shown.parentId, byId),
      createdAt: unit.createdAt,
      versions: versions.toReversed().map((v) => ({
        validFrom: v.validFrom,
        validTo: v.validTo,
        name: v.name,
        nameAr: v.nameAr ?? null,
        parentId: v.parentId,
        siteId: v.siteId,
      })),
      _actions: actions,
    };
  }

  /**
   * The unit whose scope decides access to `unitId`: the unit itself when it is part of today's tree (closure), else
   * its (shown version's) parent — a unit that starts in the future, or has ended, follows its parent.
   */
  private async scopeAnchor(companyId: string, unitId: string, parentId: string | null): Promise<string> {
    if (parentId === null || (await this.repo.inTodaysTree(companyId, unitId))) return unitId;
    return parentId;
  }

  /** Creates a non-root unit with one open-ended version from `validFrom` (default today). */
  async createUnit(input: CreateOrgUnitInput): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const catalogue = await this.kinds.catalogue();
    if (!catalogue.has(input.kind)) throw invalidKind(`Unknown kind: ${input.kind}`);
    if (catalogue.isRoot(input.kind)) throw invalidKind(`The root unit (${input.kind}) cannot be created through the API`);
    const today = this.clock.today();
    const validFrom = input.validFrom ?? today;
    const siteId = input.siteId ?? null;

    const parent = await this.repo.findUnit(companyId, input.parentId);
    // Scope (docs/contracts/authorization.md): the parent must be readable (else 404, like an unknown parent) and
    // inside the caller's org_unit.create scope (else 403 forbidden-scope).
    if (!parent || !(await this.scopes.inScope(ORG_PERMISSIONS.read, await this.unitAnchor(companyId, parent.id)))) {
      throw new NotFoundException('Parent unit not found');
    }
    if (!(await this.scopes.inScope(ORG_PERMISSIONS.create, await this.unitAnchor(companyId, parent.id)))) {
      throw forbiddenScope('You cannot create units under this parent (outside your org_unit.create scope).', 'parentId');
    }
    assertParentAllowed(catalogue, input.kind, parent);
    await this.assertParentExistsOn(companyId, input.parentId, validFrom);
    if (await this.repo.codeExists(companyId, input.code)) throw codeTaken(input.code);
    await this.assertSiteExists(companyId, siteId);

    let id: string;
    try {
      id = await this.repo.insertUnit(companyId, { kind: input.kind, code: input.code });
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'org_unit_company_code_uk') throw codeTaken(input.code);
      throw error;
    }
    await this.repo.insertVersion(companyId, id, { validFrom, validTo: null, name: input.name, nameAr: input.nameAr ?? null, parentId: input.parentId, siteId });
    // The closure is the tree as of today: a unit that starts in the future joins it when it takes effect.
    if (validFrom <= today) await this.repo.insertClosureLeaf(companyId, id, input.parentId);
    return this.getUnit(id);
  }

  /** New version from `validFrom` (default today): rename, move and/or change site. */
  async changeUnit(id: string, input: ChangeOrgUnitInput): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const unit = await this.repo.findUnit(companyId, id);
    if (!unit) throw unitNotFound();
    const anchor = await this.unitAnchor(companyId, id);
    if (!(await this.scopes.inScope(ORG_PERMISSIONS.read, anchor))) throw unitNotFound();
    if (!(await this.scopes.inScope(ORG_PERMISSIONS.update, anchor))) {
      throw forbiddenScope('You cannot change this unit (outside your org_unit.update scope).');
    }
    const catalogue = await this.kinds.catalogue();
    if (input.parentId !== undefined && catalogue.isRoot(unit.kind)) {
      throw new OrgRuleViolation('org-unit-root-immutable', 'The root unit cannot be moved.', 'parentId');
    }
    const today = this.clock.today();
    const validFrom = input.validFrom ?? today;
    const plan = planNewVersion(await this.repo.listVersions(companyId, id), {
      validFrom,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
    });
    assertRootSite(catalogue, unit.kind, plan.next.siteId);
    if (plan.siteChanged) await this.assertSiteExists(companyId, plan.next.siteId);

    if (plan.moved && plan.next.parentId) {
      const newParentId = plan.next.parentId;
      // A move also needs org_unit.update on the new parent; an unreadable parent is reported like an unknown one.
      const newParent = await this.repo.findUnit(companyId, newParentId);
      const parentAnchor = newParent ? await this.unitAnchor(companyId, newParent.id) : undefined;
      const readableParent = parentAnchor !== undefined && (await this.scopes.inScope(ORG_PERMISSIONS.read, parentAnchor)) ? newParent : undefined;
      assertParentAllowed(catalogue, unit.kind, readableParent);
      if (parentAnchor === undefined || !(await this.scopes.inScope(ORG_PERMISSIONS.update, parentAnchor))) {
        throw forbiddenScope('You cannot move a unit under this parent (outside your org_unit.update scope).', 'parentId');
      }
      const onDate = new Map((await this.repo.snapshot(companyId, validFrom)).map((u) => [u.id, u.parentId]));
      if (!onDate.has(newParentId)) throw parentMissingOn(validFrom);
      assertNoCycle(id, newParentId, (unitId) => onDate.get(unitId));
    }

    try {
      await this.repo.closeVersion(companyId, plan.current.id, validFrom);
      await this.repo.insertVersion(companyId, id, plan.next);
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'org_unit_version_no_overlap_ex') {
        throw new OrgRuleViolation('org-unit-version-overlap', 'The new version overlaps an existing one.', 'validFrom');
      }
      throw error;
    }
    // Only a move effective on or before today changes today's tree (and therefore the closure).
    if (plan.moved && plan.next.parentId && validFrom <= today) {
      await this.repo.moveClosureSubtree(companyId, id, plan.next.parentId);
    }
    return this.getUnit(id);
  }

  /** {@link scopeAnchor} for a unit known only by id (parent from the version valid today, else the first one). */
  private async unitAnchor(companyId: string, unitId: string): Promise<string> {
    if (await this.repo.inTodaysTree(companyId, unitId)) return unitId;
    const versions = sortVersions(await this.repo.listVersions(companyId, unitId));
    const shown = versionAt(versions, this.clock.today()) ?? versions[0];
    return shown?.parentId ?? unitId;
  }

  private async assertParentExistsOn(companyId: string, parentId: string, date: string): Promise<void> {
    const versions = await this.repo.listVersions(companyId, parentId);
    if (!versionAt(versions, date)) throw parentMissingOn(date);
  }

  /** A referenced site must exist in the caller's company (other tenants' sites are invisible → site-not-found). */
  private async assertSiteExists(companyId: string, siteId: string | null): Promise<void> {
    if (siteId === null) return;
    const [site] = await this.sites.findByIds(companyId, [siteId]);
    if (!site) throw new OrgRuleViolation('site-not-found', 'The site does not exist.', 'siteId');
  }

  private async siteRefs(companyId: string, ids: readonly (string | null)[]): Promise<Map<string, SiteRef>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    const rows = await this.sites.findByIds(companyId, unique);
    return new Map(rows.map((s) => [s.id, { id: s.id, code: s.code, name: s.name }]));
  }
}

function codeTaken(code: string): OrgRuleViolation {
  return new OrgRuleViolation('org-unit-code-taken', `The code ${code} is already used in this company.`, 'code');
}

function parentMissingOn(date: string): OrgRuleViolation {
  return new OrgRuleViolation(
    'org-unit-invalid-parent',
    `The parent unit does not exist on ${date}.`,
    'parentId',
    'parent_not_effective',
  );
}

