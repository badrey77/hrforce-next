/** Builds the org tree / ancestor paths from one snapshot of units (their versions valid on a given date). Pure. */
import type { OrgUnitKind } from './org-unit.js';

export interface OrgSnapshotUnit {
  readonly id: string;
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
}

export interface OrgTree<T extends OrgSnapshotUnit = OrgSnapshotUnit> {
  readonly unit: T;
  readonly children: OrgTree<T>[];
}

const byCode = (a: { unit: OrgSnapshotUnit }, b: { unit: OrgSnapshotUnit }) =>
  a.unit.code < b.unit.code ? -1 : a.unit.code > b.unit.code ? 1 : 0;

/** The tree under the company unit, children sorted by code. Units whose parent is not in the snapshot are dropped. */
export function buildTree<T extends OrgSnapshotUnit>(units: readonly T[]): OrgTree<T> | undefined {
  const nodes = new Map(units.map((unit) => [unit.id, { unit, children: [] as OrgTree<T>[] }]));
  for (const node of nodes.values()) {
    if (node.unit.parentId) nodes.get(node.unit.parentId)?.children.push(node);
  }
  const sort = (node: OrgTree<T>): void => {
    node.children.sort(byCode);
    node.children.forEach(sort);
  };
  const root = [...nodes.values()].find((n) => n.unit.kind === 'company' && n.unit.parentId === null);
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
