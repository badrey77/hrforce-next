import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { requestMemo } from '../../../platform/context/request-memo.js';
import { StaffingService } from '../../staffing/index.js';
import { algiersDate } from '../domain/rules.js';
import { RecruitmentRepository, type SiteRow, type SnapshotUnitRow } from '../infra/recruitment.repository.js';
import type { SiteRef, UnitRef, UserRef } from './recruitment-views.js';

/**
 * The recruitment clock: the server's instant and "today" in Africa/Algiers (the year of a reference, target dates,
 * heads, retention). A provider so the tests can pin it.
 */
@Injectable()
export class RecruitmentClock {
  nowMs(): number {
    return Date.now();
  }

  today(): string {
    return algiersDate(this.nowMs());
  }
}

export function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

/** Today's organisation: unit references, effective sites and sub-trees (one snapshot per request). */
export class OrgLookup {
  private readonly units: ReadonlyMap<string, SnapshotUnitRow>;
  private readonly sites: ReadonlyMap<string, SiteRow>;
  private readonly children = new Map<string, string[]>();

  constructor(units: readonly SnapshotUnitRow[], sites: readonly SiteRow[]) {
    this.units = new Map(units.map((u) => [u.id, u]));
    this.sites = new Map(sites.map((s) => [s.id, s]));
    for (const u of units) if (u.parentId) this.children.set(u.parentId, [...(this.children.get(u.parentId) ?? []), u.id]);
  }

  unitRef(unitId: string): UnitRef {
    const u = this.units.get(unitId);
    return u ? { id: u.id, code: u.code, name: u.name, nameAr: u.nameAr, kind: u.kind } : { id: unitId, code: '', name: '', nameAr: null, kind: '' };
  }

  siteRef(siteId: string | null): SiteRef | null {
    const s = siteId ? this.sites.get(siteId) : undefined;
    return s ? { id: s.id, code: s.code, name: s.name } : null;
  }

  /** The unit's own site, else the nearest ancestor's. */
  effectiveSite(unitId: string): string | null {
    const seen = new Set<string>();
    let current = this.units.get(unitId);
    while (current && !seen.has(current.id)) {
      if (current.siteId) return current.siteId;
      seen.add(current.id);
      current = current.parentId ? this.units.get(current.parentId) : undefined;
    }
    return null;
  }

  /**
   * The units of `unitIds` as a forest: a unit before its sub-units, siblings by code; `parentId` is null and `depth`
   * 0 for a unit whose parent is not in the set.
   */
  tree(unitIds: ReadonlySet<string>): { unit: UnitRef; parentId: string | null; depth: number }[] {
    const out: { unit: UnitRef; parentId: string | null; depth: number }[] = [];
    const byCode = (a: string, b: string) => (this.units.get(a)?.code ?? '').localeCompare(this.units.get(b)?.code ?? '');
    const visit = (id: string, parentId: string | null, depth: number) => {
      out.push({ unit: this.unitRef(id), parentId, depth });
      for (const child of (this.children.get(id) ?? []).filter((c) => unitIds.has(c)).toSorted(byCode)) visit(child, id, depth + 1);
    };
    const tops = [...unitIds].filter((id) => {
      const parent = this.units.get(id)?.parentId;
      return this.units.has(id) && !(parent && unitIds.has(parent));
    });
    for (const id of tops.toSorted(byCode)) visit(id, null, 0);
    return out;
  }

  /** The units and all their sub-units. */
  subtree(unitIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...unitIds];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(this.children.get(id) ?? []));
    }
    return out;
  }
}

/**
 * What every recruitment use case asks about the caller (docs/contracts/recruitment.md › Scope): today's organisation,
 * the units they HEAD (their linked employment heads the unit or one above it — no grant needed), display names.
 * Everything is read in the request transaction and memoised per request.
 */
@Injectable()
export class RecruitmentAccess {
  constructor(
    private readonly repo: RecruitmentRepository,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: RecruitmentClock,
  ) {}

  org(): Promise<OrgLookup> {
    const { companyId } = caller();
    return requestMemo('recruitment:org', async () => new OrgLookup(await this.repo.orgSnapshot(companyId, this.clock.today()), await this.repo.sites(companyId)));
  }

  private members(): Promise<Map<string, string>> {
    const { companyId } = caller();
    return requestMemo('recruitment:members', () => this.repo.members(companyId));
  }

  /** id → {id, displayName}; a former member keeps their id as display name. */
  async userRefs(): Promise<(id: string | null) => UserRef | null> {
    const names = await this.members();
    return (id) => (id ? { id, displayName: names.get(id) ?? id } : null);
  }

  /**
   * The units whose openings the caller sees as a HEAD: the units their linked employment heads today and all their
   * sub-units (so the head of a region sees the openings of its agencies). Empty for a user without a linked
   * employment or who heads nothing.
   */
  headUnits(): Promise<ReadonlySet<string>> {
    const { userId } = caller();
    return requestMemo('recruitment:head-units', async () => {
      const employmentId = await this.staffing.linkedEmploymentOf(userId);
      if (!employmentId) return new Set<string>();
      const headed = await this.staffing.unitsHeadedBy(employmentId, this.clock.today());
      return headed.length === 0 ? new Set<string>() : (await this.org()).subtree(headed);
    });
  }

  can(permission: string, unitId: string): Promise<boolean> {
    return this.scopes.inScope(permission, unitId);
  }
}
