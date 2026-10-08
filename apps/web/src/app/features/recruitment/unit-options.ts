import type { UnitRef } from '../../core/employees/employees.models';
import type { OrgTreeNode } from '../../core/org/org.models';

export interface UnitOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr?: string | null;
  readonly depth: number;
}

function findNode(node: OrgTreeNode, id: string): OrgTreeNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function flatten(node: OrgTreeNode, depth: number, seen: Set<string>, out: UnitOption[]): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  out.push({ id: node.id, code: node.code, name: node.name, nameAr: node.nameAr ?? null, depth });
  for (const child of node.children) flatten(child, depth + 1, seen, out);
}

/**
 * The given units and, when the tree is readable, their sub-units (indented by depth). Without the tree only the
 * units themselves are offered.
 */
export function unitsWithSubUnits(units: readonly UnitRef[], root: OrgTreeNode | undefined): UnitOption[] {
  const out: UnitOption[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    const node = root ? findNode(root, unit.id) : undefined;
    if (node) flatten(node, 0, seen, out);
    else if (!seen.has(unit.id)) {
      seen.add(unit.id);
      out.push({ id: unit.id, code: unit.code, name: unit.name, nameAr: unit.nameAr, depth: 0 });
    }
  }
  return out;
}
