import { Injectable, NotFoundException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import {
  assertNoCycle,
  assertParentAllowed,
  OrgRuleViolation,
  type OrgUnitKind,
} from '../domain/org-unit.js';
import { ancestorPath, buildTree, type OrgSnapshotUnit, type OrgTree } from '../domain/tree.js';
import { planNewVersion, sortVersions, versionAt } from '../domain/versions.js';
import { constraintViolation, OrgUnitRepository } from '../infra/org-unit.repository.js';
import { OrgActions } from './org-actions.js';
import { OrgClock } from './org-clock.js';
import type { OrgTreeNode, OrgTreeView, OrgUnitDetail, OrgUnitSearchView } from './org-views.js';

export const SEARCH_LIMIT = 50;

export interface CreateOrgUnitInput {
  kind: Exclude<OrgUnitKind, 'company'>;
  code: string;
  name: string;
  parentId: string;
  validFrom?: string | undefined;
}

export interface ChangeOrgUnitInput {
  name?: string | undefined;
  parentId?: string | undefined;
  validFrom?: string | undefined;
}

/** A caller without a tenant has no organisation: everything is "not found". */
function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw new NotFoundException('Organisation not found');
  return companyId;
}

function unitNotFound(): NotFoundException {
  return new NotFoundException('Org unit not found');
}

/** Use cases of the Organization module. Everything runs in the request transaction. */
@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly repo: OrgUnitRepository,
    private readonly actions: OrgActions,
    private readonly clock: OrgClock,
  ) {}

  async getTree(asOf?: string): Promise<OrgTreeView> {
    const companyId = tenant();
    const date = asOf ?? this.clock.today();
    const tree = buildTree(await this.repo.snapshot(companyId, date));
    if (!tree) throw new NotFoundException(`No organisation exists on ${date}`);
    const actionsOf = await this.actions.forCaller();
    const toNode = (node: OrgTree): OrgTreeNode => ({
      id: node.unit.id,
      kind: node.unit.kind,
      code: node.unit.code,
      name: node.unit.name,
      children: node.children.map(toNode),
      _actions: actionsOf(node.unit.kind),
    });
    return { asOf: date, root: toNode(tree) };
  }

  async searchUnits(params: { q?: string | undefined; kind?: OrgUnitKind | undefined; asOf?: string | undefined }): Promise<OrgUnitSearchView> {
    const companyId = tenant();
    const asOf = params.asOf ?? this.clock.today();
    const ids = await this.repo.search(companyId, {
      asOf,
      limit: SEARCH_LIMIT,
      ...(params.q ? { q: params.q } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
    });
    if (ids.length === 0) return { items: [] };
    const byId = new Map((await this.repo.snapshot(companyId, asOf)).map((u) => [u.id, u]));
    const items = ids.flatMap((id) => {
      const unit = byId.get(id);
      if (!unit) return [];
      return [{ id: unit.id, kind: unit.kind, code: unit.code, name: unit.name, path: ancestorPath(unit.parentId, byId) }];
    });
    return { items };
  }

  /**
   * One unit with its history (newest first). name / path come from the version valid today, or — for a unit
   * whose first version starts in the future — from that first version (path as of its start date).
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
    const actionsOf = await this.actions.forCaller();
    return {
      id: unit.id,
      kind: unit.kind,
      code: unit.code,
      name: shown.name,
      path: ancestorPath(shown.parentId, byId),
      createdAt: unit.createdAt,
      versions: versions.toReversed().map((v) => ({ validFrom: v.validFrom, validTo: v.validTo, name: v.name, parentId: v.parentId })),
      _actions: actionsOf(unit.kind),
    };
  }

  /** Creates a region or a site with one open-ended version from `validFrom` (default today). */
  async createUnit(input: CreateOrgUnitInput): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const today = this.clock.today();
    const validFrom = input.validFrom ?? today;

    const parent = await this.repo.findUnit(companyId, input.parentId);
    assertParentAllowed(input.kind, parent);
    await this.assertParentExistsOn(companyId, input.parentId, validFrom);
    if (await this.repo.codeExists(companyId, input.code)) throw codeTaken(input.code);

    let id: string;
    try {
      id = await this.repo.insertUnit(companyId, { kind: input.kind, code: input.code });
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'org_unit_company_code_uk') throw codeTaken(input.code);
      throw error;
    }
    await this.repo.insertVersion(companyId, id, { validFrom, validTo: null, name: input.name, parentId: input.parentId });
    // The closure is the tree as of today: a unit that starts in the future joins it when it takes effect.
    if (validFrom <= today) await this.repo.insertClosureLeaf(companyId, id, input.parentId);
    return this.getUnit(id);
  }

  /** New version from `validFrom` (default today): rename and/or move. */
  async changeUnit(id: string, input: ChangeOrgUnitInput): Promise<OrgUnitDetail> {
    const companyId = tenant();
    const unit = await this.repo.findUnit(companyId, id);
    if (!unit) throw unitNotFound();
    if (input.parentId !== undefined && unit.kind === 'company') {
      throw new OrgRuleViolation('org-unit-root-immutable', 'The company unit cannot be moved.', 'parentId');
    }
    const today = this.clock.today();
    const validFrom = input.validFrom ?? today;
    const plan = planNewVersion(await this.repo.listVersions(companyId, id), {
      validFrom,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    });

    if (plan.moved && plan.next.parentId) {
      const newParentId = plan.next.parentId;
      assertParentAllowed(unit.kind, await this.repo.findUnit(companyId, newParentId));
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
