import { ancestorPath, effectiveSite, type OrgSnapshotUnit } from '../../organization/index.js';
import type { UnitVersionRow } from '../infra/employee.repository.js';

/**
 * The org tree at any date, from every unit version of the company (loaded once per request): each unit with its
 * version valid on the date — or, for a unit that only starts later, its earliest version (so an assignment dated
 * before its unit's first version still shows the unit). Memoised per date.
 */
export class UnitSnapshots {
  private readonly byDate = new Map<string, ReadonlyMap<string, OrgSnapshotUnit>>();

  constructor(private readonly versions: readonly UnitVersionRow[]) {}

  at(date: string): ReadonlyMap<string, OrgSnapshotUnit> {
    const hit = this.byDate.get(date);
    if (hit) return hit;
    const chosen = new Map<string, UnitVersionRow>();
    for (const v of this.versions) {
      const current = chosen.get(v.unitId);
      const covers = v.validFrom <= date && (v.validTo === null || date < v.validTo);
      const currentCovers = current !== undefined && current.validFrom <= date && (current.validTo === null || date < current.validTo);
      if (!current || (covers && !currentCovers) || (!covers && !currentCovers && v.validFrom < current.validFrom)) chosen.set(v.unitId, v);
    }
    const snapshot = new Map<string, OrgSnapshotUnit>(
      [...chosen.values()].map((v) => [
        v.unitId,
        { id: v.unitId, kind: v.kind, code: v.code, name: v.name, nameAr: v.nameAr, parentId: v.parentId, siteId: v.siteId },
      ]),
    );
    this.byDate.set(date, snapshot);
    return snapshot;
  }

  /** The unit on `date`, its ancestors (root → parent) and its effective site (own, else the nearest ancestor's). */
  unit(unitId: string, date: string): { unit: OrgSnapshotUnit; path: { id: string; name: string; nameAr: string | null }[]; siteId: string | null } | undefined {
    const snapshot = this.at(date);
    const unit = snapshot.get(unitId);
    if (!unit) return undefined;
    return { unit, path: ancestorPath(unit.parentId, snapshot), siteId: effectiveSite(unit.siteId, unit.parentId, snapshot).siteId };
  }
}
