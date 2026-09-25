import { Injectable, NotFoundException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
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
import { OrgActions } from './org-actions.js';
import { OrgClock } from './org-clock.js';
import type { OrgKindsView, OrgTreeNode, OrgTreeView, OrgUnitDetail, OrgUnitSearchView, SiteRef } from './org-views.js';

export const SEARCH_LIMIT = 50;

export interface CreateOrgUnitInput {
  kind: OrgUnitKind;
  code: string;
  name: string;
  parentId: string;
  siteId?: string | null | undefined;
  validFrom?: string | undefined;
}

export interface ChangeOrgUnitInput {
  name?: string | undefined;
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
    const siteRefs = await this.siteRefs(companyId, snapshot.map((u) => u.siteId));
    const actionsOf = await this.actions.forCaller(catalogue);
    const toNode = (node: OrgTree, inheritedSiteId: string | null): OrgTreeNode => {
      const siteId = node.unit.siteId ?? inheritedSiteId;
      return {
        id: node.unit.id,
        kind: node.unit.kind,
        code: node.unit.code,
        name: node.unit.name,
        site: siteId ? (siteRefs.get(siteId) ?? null) : null,
        children: node.children.map((child) => toNode(child, siteId)),
        _actions: actionsOf(node.unit.kind),
      };
    };
    return { asOf: date, root: toNode(tree, null) };
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
    const snapshot = await this.repo.snapshot(companyId, todays ? today : shown.validFrom);
    const byId = new Map<string, OrgSnapshotUnit>(snapshot.map((u) => [u.id, u]));
    const site = effectiveSite(shown.siteId, shown.parentId, byId);
    const siteRefs = await this.siteRefs(companyId, [site.siteId]);
    const catalogue = await this.kinds.catalogue();
    const actionsOf = await this.actions.forCaller(catalogue);
    return {
      id: unit.id,
      kind: unit.kind,
      code: unit.code,
      name: shown.name,
      site: site.siteId ? (siteRefs.get(site.siteId) ?? null) : null,
      siteInherited: site.inherited,
      path: ancestorPath(shown.parentId, byId),
      createdAt: unit.createdAt,
      versions: versions.toReversed().map((v) => ({
        validFrom: v.validFrom,
        validTo: v.validTo,
        name: v.name,
        parentId: v.parentId,
        siteId: v.siteId,
      })),
      _actions: actionsOf(unit.kind),
    };
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
    await this.repo.insertVersion(companyId, id, { validFrom, validTo: null, name: input.name, parentId: input.parentId, siteId });
    // The closure is the tree as of today: a unit that starts in the future joins it when it takes effect.
    if (validFrom <= today) await this.repo.insertClosureLeaf(companyId, id, input.parentId);
    return this.getUnit(id);
  }

  /** New version from `validFrom` (default today): rename, move and/or change site. */
  async changeUnit(id: string, input: ChangeOrgUnitInput): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const unit = await this.repo.findUnit(companyId, id);
    if (!unit) throw unitNotFound();
    const catalogue = await this.kinds.catalogue();
    if (input.parentId !== undefined && catalogue.isRoot(unit.kind)) {
      throw new OrgRuleViolation('org-unit-root-immutable', 'The root unit cannot be moved.', 'parentId');
    }
    const today = this.clock.today();
    const validFrom = input.validFrom ?? today;
    const plan = planNewVersion(await this.repo.listVersions(companyId, id), {
      validFrom,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
    });
    assertRootSite(catalogue, unit.kind, plan.next.siteId);
    if (plan.siteChanged) await this.assertSiteExists(companyId, plan.next.siteId);

    if (plan.moved && plan.next.parentId) {
      const newParentId = plan.next.parentId;
      assertParentAllowed(catalogue, unit.kind, await this.repo.findUnit(companyId, newParentId));
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

