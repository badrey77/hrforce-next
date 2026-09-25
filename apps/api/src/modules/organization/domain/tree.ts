/** Builds the org tree / ancestor paths / effective sites from one snapshot of units (versions valid on a date). Pure. */
import type { OrgUnitKind } from './org-unit.js';

export interface OrgSnapshotUnit {
  readonly id: string;
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  /** Own site of the version (null = inherited). */
  readonly siteId: string | null;
}

export interface OrgTree<T extends OrgSnapshotUnit = OrgSnapshotUnit> {
  readonly unit: T;
  readonly children: OrgTree<T>[];
}

/** What the tree needs to know about kinds (a {@link KindCatalogue} satisfies it). */
export interface KindOrdering {
  isRoot(kind: OrgUnitKind): boolean;
  sortOrder(kind: OrgUnitKind): number;
}

/**
 * The tree under the root unit (root kind, no parent), children sorted by kind sortOrder then code. Units whose
 * parent is not in the snapshot are dropped.
 */
export function buildTree<T extends OrgSnapshotUnit>(units: readonly T[], kinds: KindOrdering): OrgTree<T> | undefined {
  const nodes = new Map(units.map((unit) => [unit.id, { unit, children: [] as OrgTree<T>[] }]));
  for (const node of nodes.values()) {
    if (node.unit.parentId) nodes.get(node.unit.parentId)?.children.push(node);
  }
  const compare = (a: OrgTree<T>, b: OrgTree<T>): number =>
    kinds.sortOrder(a.unit.kind) - kinds.sortOrder(b.unit.kind) ||
    (a.unit.code < b.unit.code ? -1 : a.unit.code > b.unit.code ? 1 : 0);
  const sort = (node: OrgTree<T>): void => {
    node.children.sort(compare);
    node.children.forEach(sort);
  };
  const root = [...nodes.values()].find((n) => kinds.isRoot(n.unit.kind) && n.unit.parentId === null);
  if (root) sort(root);
  return root;
}

/** The chain root → … → `parentId` (inclusive), i.e. the ancestors of a unit whose parent is `parentId`. */
export function ancestorPath(
  parentId: string | null,
  byId: ReadonlyMap<string, OrgSnapshotUnit>,
): { id: string; name: string }[] {
  const path: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let current = parentId ? byId.get(parentId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift({ id: current.id, name: current.name });
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export interface EffectiveSite {
  /** Own site, else the nearest ancestor's; null when no unit up to the root has one. */
  readonly siteId: string | null;
  /** True when `siteId` comes from an ancestor. */
  readonly inherited: boolean;
}

/**
 * Effective site of a unit whose own site is `ownSiteId` and whose parent is `parentId`, walking up `byId`
 * (the snapshot of the same date).
 */
export function effectiveSite(
  ownSiteId: string | null,
  parentId: string | null,
  byId: ReadonlyMap<string, OrgSnapshotUnit>,
): EffectiveSite {
  if (ownSiteId) return { siteId: ownSiteId, inherited: false };
  const seen = new Set<string>();
  let current = parentId ? byId.get(parentId) : undefined;
  while (current && !seen.has(current.id)) {
    if (current.siteId) return { siteId: current.siteId, inherited: true };
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return { siteId: null, inherited: false };
}
